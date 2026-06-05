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

    if (!webhookSubscription?.id) {
        logs.error(new Error(`Missing subscription entity or ID in webhook payload: ${event.id}`));
        return;
    }

    let subscriptionEntity: Subscriptions.RazorpaySubscription;
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

    const typedFs = new TypedFirestore(db, config);
    const docRef = typedFs.getSubscriptionDoc(uid, subscriptionId);

    let paymentEntity: Payments.RazorpayPayment | null = null;
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

            const existingData = existingDoc.data();

            const dataToWrite: Partial<SubscriptionDoc> = {
                status: newStatus,
                updated_at: FieldValue.serverTimestamp(),
            };

            if (existingData?.processing_at) {
                dataToWrite.processing_at = FieldValue.delete() as any;
            }

            // Update status and timestamp on the main document
            tx.set(docRef, dataToWrite as SubscriptionDoc, { merge: true });

            // Store the raw subscription object in the canonical subcollection
            const detailsDocRef = typedFs.getSubscriptionDetailsDoc(uid, subscriptionId);
            tx.set(detailsDocRef, subscriptionEntity);

            // Store the raw payment entity directly in the payments subcollection
            if (paymentEntity) {
                const paymentRef = typedFs.getSubscriptionPaymentDoc(uid, subscriptionId, paymentEntity.id);
                tx.set(paymentRef, paymentEntity);
            }
        });

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error;
    }
};
