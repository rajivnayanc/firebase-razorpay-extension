import { FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { logs } from '../logs';
import { RazorpaySyncConfig, SubscriptionDoc } from '../types';
import { Subscriptions } from 'razorpay/dist/types/subscriptions';
import { ensureRazorpayCustomer } from '../utils/ensureCustomer';
import { acquireProcessingLock } from '../utils/processingLock';
import { TypedFirestore } from '../utils/typedFirestore';

export const buildCreateSubscription = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    const createSubscriptionHandler = async (event: any) => {
        const snap = event.data;
        if (!snap) {
            logs.error(new Error('No data associated with the event'));
            return;
        }

        const currentData = snap.data() as SubscriptionDoc | undefined;
        if (!currentData) return;

        if (currentData.status === 'created' || currentData.status === 'active') {
            logs.info(`Subscription ${event.params.id} for user ${event.params.uid} is already created/active. Skipping trigger.`);
            return;
        }

        const db = admin.firestore();
        const typedFs = new TypedFirestore(db, config);

        // Ensure Razorpay customer exists via shared utility
        let razorpayCustomerId: string | null;
        try {
            razorpayCustomerId = await ensureRazorpayCustomer(event.params.uid, config, rzp);
        } catch (customerError: any) {
            const errMsg = customerError instanceof Error ? customerError.message : (typeof customerError === 'object' ? JSON.stringify(customerError) : String(customerError));
            logs.error(new Error(`Failed to create Razorpay customer for UID ${event.params.uid}: ${errMsg}`));
            await snap.ref.update({
                status: 'failed',
                error: 'Account setup incomplete. Please contact support.',
            });
            return;
        }

        if (!razorpayCustomerId) {
            logs.error(new Error(`No linked Razorpay customer ID for UID ${event.params.uid}.`));
            await snap.ref.update({
                status: 'failed',
                error: 'Account setup incomplete. Please contact support.',
            });
            return;
        }

        // Validate productId (consistent with createOrder.ts)
        if (!currentData.productId || typeof currentData.productId !== 'string' || currentData.productId.length > 256) {
            await snap.ref.update({
                status: 'failed',
                error: 'Missing or invalid productId. A valid productId string must be provided.',
            });
            return;
        }

        const productDoc = await typedFs.getProductDoc(currentData.productId).get();

        if (!productDoc.exists) {
            logs.error(new Error(`Product ${currentData.productId} not found for UID ${event.params.uid}.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product is not available.',
            });
            return;
        }

        const productData = productDoc.data();
        if (!productData || !productData.active) {
            logs.error(new Error(`Product ${currentData.productId} is inactive or invalid.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product is not available.',
            });
            return;
        }

        // Guard: Verify it's a subscription product
        if (productData.type !== 'subscription') {
            logs.error(new Error(`Product ${currentData.productId} is a one-time product, but used in subscriptions.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product is not a subscription.',
            });
            return;
        }

        let planId: string | undefined;
        const allowedPlans = productData.allowedPlans || {};
        const interval = currentData.interval;

        if (interval && allowedPlans[interval]) {
            planId = allowedPlans[interval];
        } else {
            const planKeys = Object.keys(allowedPlans);
            if (planKeys.length === 1) {
                planId = allowedPlans[planKeys[0]];
            }
        }

        if (!planId) {
            logs.error(new Error(`No planId resolved for product '${currentData.productId}' (Interval: ${currentData.interval}).`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected plan configuration is invalid or missing.',
            });
            return;
        }

        // Retrieve total_count config from resolved plan or product level
        let resolvedTotalCount = 12;
        if (productData.plans && interval && productData.plans[interval]) {
            const planDetails = productData.plans[interval];
            resolvedTotalCount = Number(planDetails.notes?.total_count) || Number(productData.plans[interval].notes?.total_count) || 12;
        }

        // Acquire processing lock on the draft to prevent race conditions
        const shouldProcess = await acquireProcessingLock(
            snap.ref as admin.firestore.DocumentReference,
            (data) => !!(data.status === 'created' || data.status === 'active')
        );

        if (!shouldProcess) {
            return;
        }

        try {
            // Enforce only string key-value pairs for Razorpay notes metadata
            const notesMetadata: Record<string, string> = {};
            if (currentData.metadata) {
                for (const [key, value] of Object.entries(currentData.metadata)) {
                    notesMetadata[key] = String(value).substring(0, 512);
                }
            }

            const options: Subscriptions.RazorpaySubscriptionCreateRequestBody & { customer_id?: string } = {
                plan_id: planId,
                total_count: Math.min(Math.max(resolvedTotalCount, 1), 2000),
                quantity: 1,
                customer_id: razorpayCustomerId,
                notes: {
                    uid: event.params.uid,
                    subscriptionId: event.params.id, // client-draft ID
                    productId: currentData.productId,
                    ...notesMetadata,
                },
            };

            const subscription = await rzp.subscriptions.create(options);
            logs.subscriptionCreated(subscription.id, snap.ref.path);

            const subscriptionData: SubscriptionDoc = {
                productId: currentData.productId,
                interval: currentData.interval,
                metadata: currentData.metadata,
                status: subscription.status,
                draftId: event.params.id,
                created_at: FieldValue.serverTimestamp(),
            };

            // Write to the canonical subscription doc
            const canonicalDocRef = typedFs.getSubscriptionDoc(event.params.uid, subscription.id);
            await canonicalDocRef.set(subscriptionData, { merge: true });

            // Store the raw subscription object in the canonical subcollection
            const detailsDocRef = typedFs.getSubscriptionDetailsDoc(event.params.uid, subscription.id);
            await detailsDocRef.set(subscription);

            // Delete the draft document used to trigger this creation
            await snap.ref.delete();

        } catch (error: any) {
            logs.error(error);
            await snap.ref.update({
                status: 'failed',
                error: 'Failed to create Razorpay Subscription due to an internal error or validation issue',
            });
        }
    };

    return onDocumentCreated(
        `${config.customersCollection}/{uid}/subscriptions/{id}`,
        createSubscriptionHandler
    );
};
