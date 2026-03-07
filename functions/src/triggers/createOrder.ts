import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import config from '../config';
import { logs } from '../logs';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

// Lazy-init Razorpay: secrets aren't available at module load time
// (Cloud Secret Manager injects them only at function invocation)
let razorpay: InstanceType<typeof Razorpay>;
function getRazorpay() {
    if (!razorpay) {
        razorpay = new Razorpay({
            key_id: config.razorpayKeyId,
            key_secret: config.razorpayKeySecret,
        });
    }
    return razorpay;
}


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
    let shouldCreateOrder = false;
    let orderData: any = null;

    try {
        await db.runTransaction(async (t) => {
            const docSnapshot = await t.get(snap.ref as admin.firestore.DocumentReference);
            const currentData = docSnapshot.data();

            // Guard: already has order or is in a non-initial state
            if (!currentData || currentData.order_id || currentData.status === 'created' || currentData.status === 'paid') {
                return;
            }

            // If processing, check if it's stuck (e.g., > 2 minutes)
            if (currentData.status === 'processing') {
                const processingAt = currentData.processing_at?.toDate();
                if (processingAt && (Date.now() - processingAt.getTime()) < 120000) {
                    return; // Still processing normally
                }
                logs.info(`Retrying stuck order creation for session ${event.params.id}`);
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
                processing_at: FieldValue.serverTimestamp(),
            });

            shouldCreateOrder = true;
            orderData = currentData;
        });

        if (!shouldCreateOrder || !orderData) return;

        // Receipt-based duplicate check: use Firestore doc ID as receipt
        // If a previous attempt created an order with this receipt, reuse it
        const receipt = event.params.id;
        let order: any;

        try {
            const existingOrders = await getRazorpay().orders.all({ receipt });
            const matchingOrder = existingOrders?.items?.find(
                (o: any) => o.receipt === receipt && (o.status === 'created' || o.status === 'paid')
            );

            if (matchingOrder) {
                // Reuse existing order instead of creating a duplicate
                order = matchingOrder;
                logs.orderCreated(order.id, `${snap.ref.path} (reused existing)`);
            } else {
                // Create new Razorpay Order
                const options = {
                    amount: orderData.amount,
                    currency: orderData.currency || 'INR',
                    receipt,
                    notes: {
                        uid: event.params.uid,
                        sessionId: event.params.id,
                    },
                };

                order = await getRazorpay().orders.create(options);
                logs.orderCreated(order.id, snap.ref.path);
            }
        } catch (fetchError: any) {
            // If the receipt lookup fails, fall back to creating a new order
            const options = {
                amount: orderData.amount,
                currency: orderData.currency || 'INR',
                receipt,
                notes: {
                    uid: event.params.uid,
                    sessionId: event.params.id,
                },
            };

            order = await getRazorpay().orders.create(options);
            logs.orderCreated(order.id, snap.ref.path);
        }

        await snap.ref.update({
            order_id: order.id,
            status: 'created',
            created_at: FieldValue.serverTimestamp(),
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
