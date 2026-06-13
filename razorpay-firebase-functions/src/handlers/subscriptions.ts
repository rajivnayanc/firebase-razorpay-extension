import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { Subscriptions } from 'razorpay/dist/types/subscriptions';
import { Payments } from 'razorpay/dist/types/payments';
import { logs } from '../logs';
import { WebhookEvent, RazorpaySyncConfig, SubscriptionDoc } from '../types';
import { fetchWithBackoff, isTransientError } from '../utils/retry';
import { getUidByCustomerId } from '../utils/customerMapping';
import { TypedFirestore } from '../utils/typedFirestore';

export const handleSubscriptionEvent = async (
    event: WebhookEvent,
    db: admin.firestore.Firestore,
    razorpayClient: InstanceType<typeof Razorpay>,
    config: RazorpaySyncConfig
) => {
    const webhookSubscription = event.payload.subscription?.entity;

    if (!webhookSubscription?.id) return;

    let subscriptionEntity: Subscriptions.RazorpaySubscription;
    try {
        subscriptionEntity = await fetchWithBackoff(() => razorpayClient.subscriptions.fetch(webhookSubscription.id));
    } catch (err: any) {
        if (isTransientError(err)) throw err;
        return;
    }

    const customerId = subscriptionEntity.customer_id;
    if (!customerId) return;

    const uid = await getUidByCustomerId(customerId, config.customersCollection);
    if (!uid) return;

    const newStatus = String(subscriptionEntity.status);
    const subscriptionId = subscriptionEntity.id;

    const typedFs = new TypedFirestore(db, config);
    const docRef = typedFs.getSubscriptionDoc(uid, subscriptionId);

    let paymentEntity: Payments.RazorpayPayment | null = null;
    const webhookPayment = event.payload.payment?.entity || event.payload.payment;
    if (webhookPayment?.id) {
        try {
            paymentEntity = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPayment.id));
        } catch (err: any) {
            if (isTransientError(err)) throw err;
        }
    }

    let existingData: SubscriptionDoc | undefined;
    let hasStatusChanged = false; // Tracks if we actually moved forward

    try {
        await db.runTransaction(async (tx) => {
            const existingDoc = await tx.get(docRef);
            if (!existingDoc.exists) return;

            existingData = existingDoc.data();
            
            // --- IDEMPOTENCY CHECK ---
            hasStatusChanged = existingData?.status !== newStatus;

            const dataToWrite: Partial<SubscriptionDoc> = {
                status: newStatus,
                updated_at: FieldValue.serverTimestamp(),
            };

            if (existingData?.processing_at) {
                dataToWrite.processing_at = FieldValue.delete() as any;
            }

            tx.set(docRef, dataToWrite as SubscriptionDoc, { merge: true });
            tx.set(typedFs.getSubscriptionDetailsDoc(uid, subscriptionId), subscriptionEntity);

            if (paymentEntity) {
                tx.set(typedFs.getSubscriptionPaymentDoc(uid, subscriptionId, paymentEntity.id), paymentEntity);
                // Dumb Sync to global customer payments collection
                tx.set(typedFs.getCustomerPaymentDoc(uid, paymentEntity.id), paymentEntity, { merge: true });
            }
        });

        // --- IDEMPOTENT CALLBACK ---
        // Trigger if status changed, OR if it's a recurring charge/detail update
        const shouldTriggerCallback = 
            hasStatusChanged || 
            event.event === 'subscription.charged' || 
            event.event === 'subscription.updated';

        if (shouldTriggerCallback && config.onSubscriptionUpdate && existingData) {
            try {
                const updatedSubscription = { ...existingData, status: newStatus, updated_at: FieldValue.serverTimestamp() as any };
                await config.onSubscriptionUpdate(
                    uid, 
                    updatedSubscription, 
                    subscriptionEntity, 
                    paymentEntity || undefined,
                    event.event
                );
            } catch (err: any) {
                logs.error(new Error(`onSubscriptionUpdate error: ${err.message}`));
            }
        }

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error;
    }
};
