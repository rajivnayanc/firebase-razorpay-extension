import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { Orders } from 'razorpay/dist/types/orders';
import { Payments } from 'razorpay/dist/types/payments';
import { logs } from '../logs';
import { WebhookEvent, RazorpaySyncConfig } from '../types';
import { fetchWithBackoff, isTransientError } from '../utils/retry';
import { getUidByCustomerId } from '../utils/customerMapping';

export const handlePaymentEvent = async (
    event: WebhookEvent,
    db: admin.firestore.Firestore,
    razorpayClient: InstanceType<typeof Razorpay>,
    config: RazorpaySyncConfig
) => {
    const webhookPaymentId = event.payload.payment?.entity?.id || event.payload.payment?.id;
    const webhookOrderId = event.payload.order?.entity?.id || event.payload.order?.id;

    if (!webhookPaymentId && !webhookOrderId) {
        logs.error(new Error(`Missing both payment and order IDs in webhook payload: ${event.id}`));
        return;
    }

    let fetchedEntity: Orders.RazorpayOrder | Payments.RazorpayPayment | null = null;
    let isPayment = false;

    try {
        if (event.event.startsWith('payment.') && webhookPaymentId) {
            fetchedEntity = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPaymentId));
            isPayment = true;
        } else if (event.event.startsWith('order.') && webhookOrderId) {
            fetchedEntity = await fetchWithBackoff(() => razorpayClient.orders.fetch(webhookOrderId));
        } else if (webhookOrderId) {
            fetchedEntity = await fetchWithBackoff(() => razorpayClient.orders.fetch(webhookOrderId));
        } else if (webhookPaymentId) {
            fetchedEntity = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPaymentId));
            isPayment = true;
        }
    } catch (err: any) {
        logs.error(new Error(`Failed to fetch entity from Razorpay API. Event: ${event.event}. Error: ${err.message}`));
        if (isTransientError(err)) {
            throw err; // Rethrow to signal to retry
        }
        return; // Don't throw for permanent errors (like 404), skip processing
    }

    if (!fetchedEntity) {
        logs.error(new Error(`Failed to resolve entity for event: ${event.event}`));
        return;
    }

    const notes = fetchedEntity.notes;
    const sessionId = notes?.sessionId ? String(notes.sessionId) : undefined;

    let uid: string | undefined;
    const customerId = (fetchedEntity as any).customer_id;
    if (customerId) {
        const mappedUid = await getUidByCustomerId(customerId, config.customersCollection);
        if (mappedUid) {
            uid = mappedUid;
        } else {
            logs.error(new Error(`Failed to map Razorpay Customer ID ${customerId} to a Firebase UID. Rejecting webhook.`));
            return;
        }
    }

    if (!uid && notes?.uid) {
        logs.info(`[SECURITY] Using notes.uid fallback for event ${event.event}, entity ${fetchedEntity!.id}. Customer ID mapping is preferred.`);
        uid = String(notes.uid);
    }

    if (!uid || !sessionId) {
        return;
    }

    let newStatus = 'processing';
    if (isPayment) {
        if (fetchedEntity.status === 'captured') newStatus = 'paid';
        else if (fetchedEntity.status === 'failed') newStatus = 'failed';
        else newStatus = 'processing';
    } else {
        if (fetchedEntity.status === 'paid') newStatus = 'paid';
        else newStatus = 'processing';
    }

    const docRef = db.collection(config.customersCollection)
        .doc(uid)
        .collection('checkout_sessions')
        .doc(sessionId);

    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);

            if (!snap.exists) {
                logs.error(new Error(`Checkout session ${sessionId} for user ${uid} does not exist. Possible notes injection attempt.`));
                return;
            }

            const existingData = snap.data();
            const expectedOrderId = isPayment ? (fetchedEntity as any).order_id : fetchedEntity!.id;
            if (!existingData?.order_id || existingData.order_id !== expectedOrderId) {
                logs.error(new Error(`Order ID missing or mismatch for session ${sessionId}. Expected: ${existingData?.order_id}, Got: ${expectedOrderId}. Possible notes injection.`));
                return;
            }

            const dataToWrite: any = {
                status: newStatus,
                updated_at: FieldValue.serverTimestamp(),
            };

            if (!existingData?.order_id || existingData.order_id === expectedOrderId) {
                dataToWrite.processing_at = FieldValue.delete();
            }

            if (isPayment) {
                dataToWrite.razorpay_payment_id = fetchedEntity!.id;
                dataToWrite.amount = (fetchedEntity as any).amount;
                dataToWrite.currency = (fetchedEntity as any).currency;
                dataToWrite.method = (fetchedEntity as any).method;
                dataToWrite.order_id = (fetchedEntity as any).order_id;
                dataToWrite.description = (fetchedEntity as any).description;
            } else {
                dataToWrite.order_id = fetchedEntity!.id;
                dataToWrite.amount = (fetchedEntity as any).amount;
                dataToWrite.amount_paid = (fetchedEntity as any).amount_paid;
                dataToWrite.amount_due = (fetchedEntity as any).amount_due;
                dataToWrite.currency = (fetchedEntity as any).currency;
                if (webhookPaymentId) {
                    dataToWrite.razorpay_payment_id = webhookPaymentId;
                }
            }

            tx.set(docRef, dataToWrite, { merge: true });
        });

        logs.webhookProcessed(event.event, fetchedEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error;
    }
};
