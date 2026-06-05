import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { logs } from '../logs';
import { WebhookEvent, RazorpaySyncConfig } from '../types';
import { fetchWithBackoff, isTransientError } from '../utils/retry';
import { getUidByCustomerId } from '../utils/customerMapping';

export const handleSubscriptionEvent = async (
    event: WebhookEvent,
    db: admin.firestore.Firestore,
    razorpayClient: InstanceType<typeof Razorpay>,
    config: RazorpaySyncConfig
) => {
    const webhookSubscription = event.payload.subscription?.entity;

    if (!webhookSubscription?.id) {
        logs.error(new Error(`Missing subscription entity or ID in webhook payload: ${event.id}`));
        return;
    }

    let subscriptionEntity;
    try {
        subscriptionEntity = await fetchWithBackoff(() => razorpayClient.subscriptions.fetch(webhookSubscription.id));
    } catch (err: any) {
        logs.error(new Error(`Failed to fetch subscription from Razorpay API: ${webhookSubscription.id}. Error: ${err.message}`));
        if (isTransientError(err)) {
            throw err;
        }
        return;
    }

    const customerId = subscriptionEntity.customer_id;
    if (!customerId) {
        logs.error(new Error(`No customer_id found on subscription ${subscriptionEntity.id}. Cannot resolve UID.`));
        return;
    }

    const uid = await getUidByCustomerId(customerId, config.customersCollection);
    if (!uid) {
        logs.error(new Error(`No Firebase UID found mapped to Razorpay Customer ID ${customerId} for subscription ${subscriptionEntity.id}`));
        return;
    }

    const newStatus = String(subscriptionEntity.status);
    const subscriptionId = subscriptionEntity.id;
    const docRef = db.collection(config.customersCollection)
        .doc(uid)
        .collection('subscriptions')
        .doc(subscriptionId);

    let paymentEntity = null;
    const webhookPayment = event.payload.payment?.entity || (event.payload.payment?.id ? event.payload.payment : null);
    if (webhookPayment?.id) {
        try {
            paymentEntity = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPayment.id));
        } catch (err: any) {
            logs.error(new Error(`Failed to fetch payment from Razorpay API: ${webhookPayment.id}. Error: ${err.message}`));
            if (isTransientError(err)) {
                throw err;
            }
        }
    }

    try {
        await db.runTransaction(async (tx) => {
            const existingDoc = await tx.get(docRef);
            if (!existingDoc.exists) {
                logs.error(new Error(`Subscription document does not exist in Firestore for ID: ${subscriptionId}. Rejecting webhook event.`));
                return;
            }

            const dataToWrite: any = {
                subscription_id: subscriptionEntity.id,
                plan_id: subscriptionEntity.plan_id,
                status: newStatus,
                current_start: subscriptionEntity.current_start,
                current_end: subscriptionEntity.current_end,
                total_count: subscriptionEntity.total_count,
                paid_count: subscriptionEntity.paid_count,
                remaining_count: subscriptionEntity.remaining_count,
                charge_at: subscriptionEntity.charge_at,
                short_url: subscriptionEntity.short_url,
                updated_at: FieldValue.serverTimestamp(),
            };

            if (existingDoc.data()?.subscription_id === subscriptionEntity.id) {
                dataToWrite.processing_at = FieldValue.delete();
            }

            tx.set(docRef, dataToWrite, { merge: true });

            if (paymentEntity) {
                const paymentRef = docRef.collection('payments').doc(paymentEntity.id);
                tx.set(paymentRef, {
                    payment_id: paymentEntity.id,
                    amount: (paymentEntity as any).amount,
                    currency: (paymentEntity as any).currency,
                    status: (paymentEntity as any).status,
                    method: (paymentEntity as any).method,
                    order_id: (paymentEntity as any).order_id,
                    updated_at: FieldValue.serverTimestamp(),
                }, { merge: true });
            }
        });

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error;
    }
};
