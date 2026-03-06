import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import config from '../config';
import { logs } from '../logs';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const razorpay = new Razorpay({
    key_id: config.razorpayKeyId,
    key_secret: config.razorpayKeySecret,
});

export const createOrderHandler = async (event: any) => {
    // Only process if it matches the configured collection
    if (event.params.customers_collection !== config.customersCollectionPath) return;

    const snap = event.data;
    if (!snap) {
        logs.error(new Error('No data associated with the event'));
        return;
    }

    const db = admin.firestore();

    // Use Firestore Transaction to prevent TOCTOU race condition
    // Two concurrent triggers cannot both acquire the "processing" lock
    let shouldCreateOrder = false;
    let orderData: any = null;

    try {
        await db.runTransaction(async (t) => {
            const docSnapshot = await t.get(snap.ref as admin.firestore.DocumentReference);
            const currentData = docSnapshot.data();

            // Guard: already has order or is in a non-initial state
            if (!currentData || currentData.order_id || currentData.status === 'processing' ||
                currentData.status === 'created' || currentData.status === 'paid') {
                return;
            }

            // Server-side amount validation
            if (!currentData.amount || currentData.amount <= 0) {
                t.update(snap.ref, {
                    status: 'failed',
                    error: 'Invalid amount: must be a positive integer (in paise)',
                });
                return;
            }

            // Acquire lock atomically
            t.update(snap.ref, {
                status: 'processing',
                processing_at: admin.firestore.FieldValue.serverTimestamp(),
            });

            shouldCreateOrder = true;
            orderData = currentData;
        });

        if (!shouldCreateOrder || !orderData) return;

        // Create Razorpay Order (OUTSIDE transaction — external API calls must not be in transactions)
        const options = {
            amount: orderData.amount,
            currency: orderData.currency || 'INR',
            receipt: event.params.id,
            notes: {
                uid: event.params.uid,
                sessionId: event.params.id,
            },
        };

        const order = await razorpay.orders.create(options);
        logs.orderCreated(order.id, snap.ref.path);

        await snap.ref.update({
            order_id: order.id,
            status: 'created',
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        });

    } catch (error: any) {
        logs.error(error);
        await snap.ref.update({
            status: 'failed',
            error: error.message || 'Failed to create Razorpay Order',
        });
    }
};

export const createOrder = onDocumentCreated(
    `{customers_collection}/{uid}/checkout_sessions/{id}`,
    createOrderHandler
);
