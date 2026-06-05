import { FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { logs } from '@/logs';
import { RazorpaySyncConfig } from '@/types';

export const buildCreateSubscription = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    const createSubscriptionHandler = async (event: any) => {
        const snap = event.data;
        if (!snap) {
            logs.error(new Error('No data associated with the event'));
            return;
        }

        const currentData = snap.data();
        if (!currentData) return;

        if (currentData.subscription_id || currentData.status === 'created' || currentData.status === 'active') {
            logs.info(`Subscription ${event.params.id} for user ${event.params.uid} is already created/active. Skipping trigger.`);
            return;
        }

        const db = admin.firestore();

        const customerDoc = await db.collection(config.customersCollection).doc(event.params.uid).get();
        const customerData = customerDoc.data() || {};
        let razorpayCustomerId = customerData.razorpay_customer_id;

        if (!razorpayCustomerId) {
            if (config.syncCustomers) {
                try {
                    const userRec = await admin.auth().getUser(event.params.uid).catch(() => null);
                    const newCustomer = await rzp.customers.create({
                        name: userRec?.displayName || customerData.name || 'Firebase User',
                        email: userRec?.email || customerData.email || undefined,
                        contact: userRec?.phoneNumber || customerData.phone || undefined,
                        fail_existing: '0',
                    } as any);
                    razorpayCustomerId = newCustomer.id;
                    await customerDoc.ref.set({ razorpay_customer_id: razorpayCustomerId }, { merge: true });
                    logs.info(`Created Razorpay customer ${razorpayCustomerId} for UID ${event.params.uid}`);
                } catch (customerError: any) {
                    const errMsg = customerError instanceof Error ? customerError.message : (typeof customerError === 'object' ? JSON.stringify(customerError) : String(customerError));
                    logs.error(new Error(`Failed to dynamically create Razorpay customer for UID ${event.params.uid}: ${errMsg}`));
                    await snap.ref.update({
                        status: 'failed',
                        error: 'Account setup incomplete. Please contact support.',
                    });
                    return;
                }
            } else {
                logs.error(new Error(`No linked Razorpay customer ID for UID ${event.params.uid} and syncCustomers is disabled.`));
                await snap.ref.update({
                    status: 'failed',
                    error: 'Account setup incomplete. Please contact support.',
                });
                return;
            }
        }

        if (currentData.plan_id) {
            await snap.ref.update({
                status: 'failed',
                error: 'Providing plan_id directly is not allowed. Provide productId and interval instead.',
            });
            return;
        }

        const productRef = db.collection(config.productsCollection).doc(currentData.productId);
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
        let planId = productData.planId;

        if (!planId) {
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
        }

        if (!planId) {
            logs.error(new Error(`No planId resolved for product '${currentData.productId}' (Interval: ${currentData.interval}).`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected plan configuration is invalid or missing.',
            });
            return;
        }

        let secureRole = productData.firebaseRole || productData.notes?.firebaseRole || productData.razorpay_notes_firebaseRole || '';

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
                    return;
                }
            }

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
            const options: any = {
                plan_id: planId,
                total_count: Math.min(Math.max(Number(productData.total_count) || 12, 1), 2000),
                quantity: 1,
                customer_id: razorpayCustomerId,
                notes: {
                    uid: event.params.uid,
                    subscriptionId: event.params.id,
                    productId: currentData.productId,
                },
            };

            const subscription = await rzp.subscriptions.create(options);
            logs.subscriptionCreated(subscription.id, snap.ref.path);

            const subscriptionData = {
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
                firebaseRole: secureRole,
            };

            await snap.ref.update(subscriptionData);

            const canonicalDocRef = db.collection(config.customersCollection)
                .doc(event.params.uid)
                .collection('subscriptions')
                .doc(subscription.id);
            await canonicalDocRef.set(subscriptionData, { merge: true });

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
