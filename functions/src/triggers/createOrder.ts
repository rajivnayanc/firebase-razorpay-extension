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

export const createOrder = onDocumentCreated(
    `{customers_collection}/{uid}/checkout_sessions/{id}`,
    async (event) => {
        // Only process if it matches the configured collection
        if (event.params.customers_collection !== config.customersCollectionPath) return;

        const snap = event.data;
        if (!snap) {
            logs.error(new Error('No data associated with the event'));
            return;
        }

        const data = snap.data();

        // Check if order already processing or completed
        if (data.order_id || data.status === 'processing') return;

        try {
            await snap.ref.update({ status: 'processing' });

            // Create Razorpay Order
            // Razorpay expects amount in paise (smallest currency unit)
            const options = {
                amount: data.amount,
                currency: data.currency || 'INR',
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
    }
);
