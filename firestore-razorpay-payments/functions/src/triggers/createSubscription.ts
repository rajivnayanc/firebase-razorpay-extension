import { FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';
import { getRazorpay } from '../api';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

export const createSubscriptionHandler = async (event: any) => {
    // When deployed as an extension, the trigger path is resolved by extension.yaml
    // and the `{customers_collection}` wildcard is replaced with the actual collection name.
    // In that case, `event.params.customers_collection` will be undefined.
    if (event.params.customers_collection && event.params.customers_collection !== config.customersCollectionPath) return;

    const snap = event.data;
    if (!snap) {
        logs.error(new Error('No data associated with the event'));
        return;
    }

    const currentData = snap.data();
    const db = admin.firestore();

    // Server-side validation: plan_id is required
    if (!currentData.plan_id) {
        await snap.ref.update({
            status: 'failed',
            error: 'Missing required field: plan_id',
        });
        return;
    }

    if (currentData.subscription_id || currentData.status === 'created' || currentData.status === 'active') {
        return;
    }

    if (currentData.status === 'processing') {
        const processingAt = currentData.processing_at?.toDate();
        if (processingAt && (Date.now() - processingAt.getTime()) < 120000) {
            return; // Still processing normally
        }
    }

    // Securely fetch the plan document to get the assigned firebaseRole
    const planRef = db.collection(config.productsCollectionPath).doc(currentData.plan_id);
    const planDoc = await planRef.get();

    if (!planDoc.exists) {
        await snap.ref.update({
            status: 'failed',
            error: `Invalid plan_id: ${currentData.plan_id} not found in synced plans.`,
        });
        return;
    }

    const planData = planDoc.data() || {};
    // Prefer the razorpay notes synced field, fallback to manually set string
    let secureRole = planData.notes?.firebaseRole || planData.razorpay_notes_firebaseRole || planData.firebaseRole || '';

    // Acquire lock
    await snap.ref.update({
        status: 'processing',
        processing_at: FieldValue.serverTimestamp(),
    });

    try {
        // Create Razorpay Subscription
        // Note: as of current Razorpay SDK, `customer_id` is missing from `RazorpaySubscriptionCreateRequestBody`
        // despite being an official parameter in their API docs. We cast to any to proceed:
        const options: any = {
            plan_id: currentData.plan_id,
            total_count: currentData.total_count || 12,
            quantity: currentData.quantity || 1,
            customer_id: currentData.razorpay_customer_id,
            notes: {
                uid: event.params.uid,
                subscriptionId: event.params.id,
                firebaseRole: secureRole,
            },
        };

        const subscription = await getRazorpay().subscriptions.create(options);
        logs.subscriptionCreated(subscription.id, snap.ref.path);

        await snap.ref.update({
            ...subscription,
            subscription_id: subscription.id,
            status: subscription.status,
            short_url: subscription.short_url,
            created_at: FieldValue.serverTimestamp(),
        });

    } catch (error: any) {
        logs.error(error);
        await snap.ref.update({
            status: 'failed',
            error: error.message || 'Failed to create Razorpay Subscription',
        });
    }
};

export const createSubscription = onDocumentCreated(
    `{customers_collection}/{uid}/subscriptions/{id}`,
    createSubscriptionHandler
);
