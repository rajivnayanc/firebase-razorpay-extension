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

    // Fetch the canonical customer document using the trusted UID from the document path
    const customerDoc = await db.collection(config.customersCollectionPath).doc(event.params.uid).get();
    if (!customerDoc.exists) {
        logs.error(new Error(`Customer record for UID ${event.params.uid} does not exist.`));
        await snap.ref.update({
            status: 'failed',
            error: 'Account setup incomplete. Please contact support.',
        });
        return;
    }
    const customerData = customerDoc.data() || {};
    const razorpayCustomerId = customerData.razorpay_customer_id;

    if (!razorpayCustomerId) {
        logs.error(new Error(`No linked Razorpay customer ID for UID ${event.params.uid}.`));
        await snap.ref.update({
            status: 'failed',
            error: 'Account setup incomplete. Please contact support.',
        });
        return;
    }

    // Server-side validation: productId and interval are required
    if (currentData.plan_id) {
        await snap.ref.update({
            status: 'failed',
            error: 'Providing plan_id directly is not allowed. Provide productId and interval instead.',
        });
        return;
    }

    if (!currentData.productId || typeof currentData.productId !== 'string' || currentData.productId.length > 256 ||
        !currentData.interval || typeof currentData.interval !== 'string' || currentData.interval.length > 64) {
        await snap.ref.update({
            status: 'failed',
            error: 'Missing or invalid required fields: productId and interval must be valid strings.',
        });
        return;
    }

    // Securely fetch the product document to get the assigned firebaseRole and planId
    const productRef = db.collection(config.productsCollectionPath).doc(currentData.productId);
    const productDoc = await productRef.get();

    if (!productDoc.exists) {
        logs.error(new Error(`Product ${currentData.productId} not found for UID ${event.params.uid}.`));
        await snap.ref.update({
            status: 'failed',
            error: 'The selected product is not available.',
        });
        return;
    }

    const productData = productDoc.data() || {};
    const allowedPlans = productData.allowedPlans || {};
    const planId = allowedPlans[currentData.interval];

    if (!planId) {
        logs.error(new Error(`No plan for interval '${currentData.interval}' on product '${currentData.productId}'.`));
        await snap.ref.update({
            status: 'failed',
            error: 'The selected plan is not available.',
        });
        return;
    }

    let secureRole = productData.firebaseRole || productData.notes?.firebaseRole || productData.razorpay_notes_firebaseRole || '';

    // Acquire lock using a transaction
    let shouldProcess = false;
    await admin.firestore().runTransaction(async (transaction) => {
        const docSnap = await transaction.get(snap.ref as admin.firestore.DocumentReference);
        if (!docSnap.exists) return;
        const txData = docSnap.data();
        if (!txData) return;

        if (txData.subscription_id || txData.status === 'created' || txData.status === 'active') {
            shouldProcess = false;
            return;
        }

        if (txData.status === 'processing') {
            const processingAt = txData.processing_at?.toDate();
            if (processingAt && (Date.now() - processingAt.getTime()) < 120000) {
                shouldProcess = false;
                return; // Still processing normally
            }
        }

        // Lock the document
        transaction.update(snap.ref, {
            status: 'processing',
            processing_at: FieldValue.serverTimestamp(),
        });
        shouldProcess = true;
    });

    if (!shouldProcess) {
        return;
    }

    try {
        // Create Razorpay Subscription
        // Note: as of current Razorpay SDK, `customer_id` is missing from `RazorpaySubscriptionCreateRequestBody`
        // despite being an official parameter in their API docs. We cast to any to proceed:
        const options: any = {
            plan_id: planId,
            total_count: Math.min(Math.max(Number(productData.total_count) || 12, 1), 2000),
            quantity: 1, // Securely forced to 1
            customer_id: razorpayCustomerId,
            notes: {
                uid: event.params.uid,
                subscriptionId: event.params.id,
                productId: currentData.productId,
                firebaseRole: secureRole,
            },
        };

        const subscription = await getRazorpay().subscriptions.create(options);
        logs.subscriptionCreated(subscription.id, snap.ref.path);

        await snap.ref.update({
            subscription_id: subscription.id,
            plan_id: subscription.plan_id,
            status: subscription.status,
            short_url: subscription.short_url,
            current_start: subscription.current_start,
            current_end: subscription.current_end,
            total_count: subscription.total_count,
            paid_count: subscription.paid_count,
            remaining_count: subscription.remaining_count,
            charge_at: subscription.charge_at,
            created_at: FieldValue.serverTimestamp(),
        });

    } catch (error: any) {
        logs.error(error);
        await snap.ref.update({
            status: 'failed',
            error: 'Failed to create Razorpay Subscription due to an internal error or validation issue',
        });
    }
};

export const createSubscription = onDocumentCreated(
    `{customers_collection}/{uid}/subscriptions/{id}`,
    createSubscriptionHandler
);
