import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { Orders } from 'razorpay/dist/types/orders';
import { Payments } from 'razorpay/dist/types/payments';
import { logs } from '../logs';
import { WebhookEvent, RazorpaySyncConfig, CheckoutSessionDoc } from '../types';
import { fetchWithBackoff, isTransientError } from '../utils/retry';
import { getUidByCustomerId } from '../utils/customerMapping';
import { TypedFirestore } from '../utils/typedFirestore';

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
            throw err;
        }
        return;
    }

    const fetchedEntity = fetchedPayment || fetchedOrder;

    if (!fetchedEntity) {
        logs.error(new Error(`Failed to resolve entity for event: ${event.event}`));
        return;
    }

    const notes = fetchedEntity.notes;
    const sessionId = notes?.sessionId ? String(notes.sessionId) : undefined;

    let uid: string | undefined;
    const customerId = (isPayment && fetchedPayment)
        ? fetchedPayment.customer_id
        : (fetchedOrder ? (fetchedOrder as any).customer_id : undefined);

    if (customerId) {
        const mappedUid = await getUidByCustomerId(customerId, config.customersCollection);
        if (mappedUid) {
            uid = mappedUid;
        } else {
            logs.error(new Error(`Failed to map Razorpay Customer ID ${customerId} to a Firebase UID. Rejecting webhook.`));
            return;
        }
    }

    if (!uid) {
        logs.error(new Error(`Cannot resolve UID for event ${event.event}. No customer_id mapping and notes.uid fallback removed for security.`));
        return;
    }

    if (!sessionId) {
        logs.error(new Error(`Missing sessionId in notes for event ${event.event}.`));
        return;
    }

    let newStatus: 'processing' | 'paid' | 'failed' = 'processing';
    if (isPayment && fetchedPayment) {
        if (fetchedPayment.status === 'captured') newStatus = 'paid';
        else if (fetchedPayment.status === 'failed') newStatus = 'failed';
        else newStatus = 'processing';
    } else if (fetchedOrder) {
        if (fetchedOrder.status === 'paid') newStatus = 'paid';
        else newStatus = 'processing';
    }

    const typedFs = new TypedFirestore(db, config);
    const docRef = typedFs.getCheckoutSessionDoc(uid, sessionId);
    const orderDocRef = typedFs.getCheckoutSessionOrderDoc(uid, sessionId);

    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);

            if (!snap.exists) {
                logs.error(new Error(`Checkout session ${sessionId} for user ${uid} does not exist. Possible notes injection attempt.`));
                return;
            }

            // Secure validation: Fetch the server-written order document inside the transaction to verify order ID
            const orderSnap = await tx.get(orderDocRef);
            if (!orderSnap.exists) {
                logs.error(new Error(`Order details missing for session ${sessionId}. Possible notes injection.`));
                return;
            }

            const orderData = orderSnap.data();
            const expectedOrderId = isPayment && fetchedPayment ? fetchedPayment.order_id : fetchedOrder!.id;
            if (!orderData || orderData.id !== expectedOrderId) {
                logs.error(new Error(`Order ID mismatch for session ${sessionId}. Expected: ${orderData?.id}, Got: ${expectedOrderId}. Possible notes injection.`));
                return;
            }

            const dataToWrite: Partial<CheckoutSessionDoc> = {
                status: newStatus,
                updated_at: FieldValue.serverTimestamp(),
            };

            const existingData = snap.data();
            if (existingData?.processing_at) {
                dataToWrite.processing_at = FieldValue.delete() as any;
            }

            // Update status and timestamp on the main document
            tx.set(docRef, dataToWrite as CheckoutSessionDoc, { merge: true });

            // Store raw Razorpay responses in separate subcollection documents
            if (isPayment && fetchedPayment) {
                const paymentDocRef = typedFs.getCheckoutSessionPaymentDoc(uid, sessionId);
                tx.set(paymentDocRef, fetchedPayment);
            } else if (fetchedOrder) {
                tx.set(orderDocRef, fetchedOrder);
            }
        });

        logs.webhookProcessed(event.event, fetchedEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error;
    }
};
