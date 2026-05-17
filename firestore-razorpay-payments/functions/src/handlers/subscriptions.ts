import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import config from '../config';
import { logs } from '../logs';
import { WebhookEvent } from '../api';
import { fetchWithBackoff, isTransientError } from '../utils/retry';
import { getUidByCustomerId } from '../utils/customerMapping';


export const handleSubscriptionEvent = async (event: WebhookEvent, db: admin.firestore.Firestore, razorpayClient: InstanceType<typeof Razorpay>) => {
    const webhookSubscription = event.payload.subscription?.entity;

    if (!webhookSubscription?.id) {
        logs.error(new Error(`Missing subscription entity or ID in webhook payload: ${event.id}`));
        return;
    }

    let subscriptionEntity;
    try {
        // FETCH latest state from Razorpay API as source of truth with backoff
        subscriptionEntity = await fetchWithBackoff(() => razorpayClient.subscriptions.fetch(webhookSubscription.id));
    } catch (err: any) {
        logs.error(new Error(`Failed to fetch subscription from Razorpay API: ${webhookSubscription.id}. Error: ${err.message}`));
        if (isTransientError(err)) {
            throw err; // Rethrow to signal api.ts to return 500
        }
        return; // Don't throw for permanent errors (like 404), skip processing
    }

    const customerId = subscriptionEntity.customer_id;
    if (!customerId) {
        logs.error(new Error(`No customer_id found on subscription ${subscriptionEntity.id}. Cannot resolve UID.`));
        return;
    }

    const uid = await getUidByCustomerId(customerId);
    if (!uid) {
        logs.error(new Error(`No Firebase UID found mapped to Razorpay Customer ID ${customerId} for subscription ${subscriptionEntity.id}`));
        return;
    }

    // Use the fetched subscription status directly
    const newStatus = String(subscriptionEntity.status);

    // Enforce using the Razorpay subscription.id as the Firestore document ID universally
    const subscriptionId = subscriptionEntity.id;
    const docRef = db.collection(config.customersCollectionPath)
        .doc(uid)
        .collection('subscriptions')
        .doc(subscriptionId);

    // If there's a payment attached to the webhook, fetch its authoritative state
    let paymentEntity = null;
    const webhookPayment = event.payload.payment?.entity || (event.payload.payment?.id ? event.payload.payment : null);
    if (webhookPayment?.id) {
        try {
            paymentEntity = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPayment.id));
        } catch (err: any) {
            logs.error(new Error(`Failed to fetch payment from Razorpay API: ${webhookPayment.id}. Error: ${err.message}`));
            if (isTransientError(err)) {
                throw err; // Rethrow to allow retry
            }
            // We can continue with the subscription update even if payment fetch fails permanently
        }
    }
    
    try {
        // Read the role strictly from the existing Firestore document (which was securely set by createSubscription.ts)
        const existingDoc = await docRef.get();
        if (!existingDoc.exists) {
            logs.error(new Error(`Subscription document does not exist in Firestore for ID: ${subscriptionId}. Rejecting webhook event.`));
            return;
        }

        // Write atomically and forcefully overwrite any stuck states ('processing')
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
            // Only clear processing_at if this webhook belongs to the same subscription.
            // Since subscription docs use subscription_id as the doc ID (1:1), this is a safety
            // check against edge cases where the doc was somehow reused or the subscription_id
            // in the existing doc doesn't match (e.g., data corruption).
            ...((! existingDoc.exists || existingDoc.data()?.subscription_id === subscriptionEntity.id)
                ? { processing_at: FieldValue.delete() }
                : {}),
        };



        const batch = db.batch();
        batch.set(docRef, dataToWrite, { merge: true });

        if (paymentEntity) {
            const paymentRef = docRef.collection('payments').doc(paymentEntity.id);
            batch.set(paymentRef, {
                payment_id: paymentEntity.id,
                amount: (paymentEntity as any).amount,
                currency: (paymentEntity as any).currency,
                status: (paymentEntity as any).status,
                method: (paymentEntity as any).method,
                order_id: (paymentEntity as any).order_id,
                updated_at: FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        
        await batch.commit();

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error; // Let api.ts catch and handle it for retries
    }
};
