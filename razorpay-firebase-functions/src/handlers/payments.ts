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

    let fetchedPayment: Payments.RazorpayPayment | null = null;
    let fetchedOrder: Orders.RazorpayOrder | null = null;
    let isPayment = false;

    try {
        if (event.event.startsWith('payment.') && webhookPaymentId) {
            fetchedPayment = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPaymentId));
            isPayment = true;
        } else if (event.event.startsWith('order.') && webhookOrderId) {
            fetchedOrder = await fetchWithBackoff(() => razorpayClient.orders.fetch(webhookOrderId));
        } else if (webhookOrderId) {
            fetchedOrder = await fetchWithBackoff(() => razorpayClient.orders.fetch(webhookOrderId));
        } else if (webhookPaymentId) {
            fetchedPayment = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPaymentId));
            isPayment = true;
        }
    } catch (err: any) {
        logs.error(new Error(`Failed to fetch entity from Razorpay API. Event: ${event.event}. Error: ${err.message}`));
        if (isTransientError(err)) {
            throw err; // Rethrow to signal to retry
        }
        return; // Don't throw for permanent errors (like 404), skip processing
    }

    const fetchedEntity = fetchedPayment || fetchedOrder;

    if (!fetchedEntity) {
        logs.error(new Error(`Failed to resolve entity for event: ${event.event}`));
        return;
    }

    const notes = fetchedEntity.notes;
    const sessionId = notes?.sessionId ? String(notes.sessionId) : undefined;

    let uid: string | undefined;
    const customerId = isPayment
        ? (fetchedPayment as Payments.RazorpayPayment).customer_id
        : undefined;
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
        logs.info(`[SECURITY] Using notes.uid fallback for event ${event.event}, entity ${fetchedEntity.id}. Customer ID mapping is preferred.`);
        uid = String(notes.uid);
    }

    if (!uid || !sessionId) {
        return;
    }

    let newStatus = 'processing';
    if (isPayment && fetchedPayment) {
        if (fetchedPayment.status === 'captured') newStatus = 'paid';
        else if (fetchedPayment.status === 'failed') newStatus = 'failed';
        else newStatus = 'processing';
    } else if (fetchedOrder) {
        if (fetchedOrder.status === 'paid') newStatus = 'paid';
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
            const expectedOrderId = isPayment && fetchedPayment ? fetchedPayment.order_id : fetchedOrder!.id;
            if (!existingData?.order_id || existingData.order_id !== expectedOrderId) {
                logs.error(new Error(`Order ID missing or mismatch for session ${sessionId}. Expected: ${existingData?.order_id}, Got: ${expectedOrderId}. Possible notes injection.`));
                return;
            }

            const dataToWrite: Record<string, unknown> = {
                status: newStatus,
                updated_at: FieldValue.serverTimestamp(),
            };

            if (!existingData?.order_id || existingData.order_id === expectedOrderId) {
                dataToWrite.processing_at = FieldValue.delete();
            }

            if (isPayment && fetchedPayment) {
                dataToWrite.razorpay_payment_id = fetchedPayment.id;
                dataToWrite.amount = fetchedPayment.amount;
                dataToWrite.currency = fetchedPayment.currency;
                dataToWrite.method = fetchedPayment.method;
                dataToWrite.order_id = fetchedPayment.order_id;
                dataToWrite.description = fetchedPayment.description;
            } else if (fetchedOrder) {
                dataToWrite.order_id = fetchedOrder.id;
                dataToWrite.amount = fetchedOrder.amount;
                dataToWrite.amount_paid = fetchedOrder.amount_paid;
                dataToWrite.amount_due = fetchedOrder.amount_due;
                dataToWrite.currency = fetchedOrder.currency;
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
