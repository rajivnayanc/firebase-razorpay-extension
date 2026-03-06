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

export const createSubscription = onDocumentCreated(
    `{customers_collection}/{uid}/subscriptions/{id}`,
    async (event) => {
        // Only process if it matches the configured collection
        if (event.params.customers_collection !== config.customersCollectionPath) return;

        const snap = event.data;
        if (!snap) {
            logs.error(new Error('No data associated with the event'));
            return;
        }

        const data = snap.data();

        // Check if subscription already processing or created
        if (data.subscription_id || data.status === 'processing') return;

        try {
            await snap.ref.update({ status: 'processing' });

            // Create Razorpay Subscription
            const options = {
                plan_id: data.plan_id,
                total_count: data.total_count || 12, // Default to 12 billing cycles if not provided
                quantity: data.quantity || 1,
                customer_id: data.razorpay_customer_id, // Ensure customer is already created in Razorpay
                notes: {
                    uid: event.params.uid,
                    subscriptionId: event.params.id,
                    firebaseRole: data.firebaseRole || '',
                },
            };

            const subscription = await razorpay.subscriptions.create(options);
            logs.subscriptionCreated(subscription.id, snap.ref.path);

            await snap.ref.update({
                subscription_id: subscription.id,
                status: subscription.status,
                short_url: subscription.short_url,
                created_at: admin.firestore.FieldValue.serverTimestamp(),
            });

        } catch (error: any) {
            logs.error(error);
            await snap.ref.update({
                status: 'failed',
                error: error.message || 'Failed to create Razorpay Subscription',
            });
        }
    }
);
