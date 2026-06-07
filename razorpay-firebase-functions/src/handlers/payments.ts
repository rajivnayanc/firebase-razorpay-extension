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
        logs.error(new Error(`API Fetch Failed. Event: ${event.event}. Error: ${err.message}`));
        if (isTransientError(err)) throw err;
        return;
    }

    const notes = fetchedPayment?.notes || fetchedOrder?.notes;
    const sessionId = notes?.sessionId ? String(notes.sessionId) : undefined;

    let uid: string | undefined;
    const customerId = (isPayment && fetchedPayment)
        ? fetchedPayment.customer_id
        : (fetchedOrder ? (fetchedOrder as any).customer_id : undefined);

    if (customerId) {
        const mappedUid = await getUidByCustomerId(customerId, config.customersCollection);
        if (mappedUid) {
            uid = mappedUid;
        }
    }
    if (!uid && notes?.uid) {
        uid = String(notes.uid); // Fallback to notes
    }

    if (!uid) {
        logs.error(new Error(`Cannot resolve UID for event ${event.event}.`));
        return;
    }

    const typedFs = new TypedFirestore(db, config);

    // ========================================================================
    // PART 1: THE STRIPE APPROACH ("Dumb" Mirroring)
    // Always write the raw entity to a dedicated collection so Firestore 
    // exactly matches Razorpay, regardless of overlapping events.
    // ========================================================================
    const batch = db.batch();
    if (fetchedPayment) {
        const paymentRef = typedFs.getCustomerPaymentDoc(uid, fetchedPayment.id);
        batch.set(paymentRef, fetchedPayment, { merge: true });
    }
    if (fetchedOrder) {
        const orderRef = typedFs.getCustomerOrderDoc(uid, fetchedOrder.id);
        batch.set(orderRef, fetchedOrder, { merge: true });
    }
    await batch.commit();

    // --- SMART SEGREGATION ---
    // If there is no sessionId, this is NOT a one-time checkout session. 
    // It is likely a subscription payment/order. We exit gracefully without throwing an error.
    if (!sessionId) {
        logs.info(`Skipping ${event.event} - No sessionId in notes. Likely a Subscription event.`);
        return;
    }

    let newStatus: 'processing' | 'paid' | 'failed' = 'processing';
    if (isPayment && fetchedPayment) {
        if (fetchedPayment.status === 'captured') newStatus = 'paid';
        else if (fetchedPayment.status === 'failed') newStatus = 'failed';
    } else if (fetchedOrder) {
        if (fetchedOrder.status === 'paid') newStatus = 'paid';
    }

    const docRef = typedFs.getCheckoutSessionDoc(uid, sessionId);
    const orderDocRef = typedFs.getCheckoutSessionOrderDoc(uid, sessionId);

    let existingData: CheckoutSessionDoc | undefined;
    let hasStatusChanged = false; // Tracks if we actually moved forward

    try {
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(docRef);

            if (!snap.exists) {
                logs.error(new Error(`Checkout session missing. Possible notes injection.`));
                return;
            }

            existingData = snap.data();
            hasStatusChanged = existingData?.status !== newStatus;

            // --- TRUST BUT VERIFY (SECURITY) ---
            const orderSnap = await tx.get(orderDocRef);
            const expectedOrderId = isPayment && fetchedPayment ? fetchedPayment.order_id : fetchedOrder!.id;
            
            if (!orderSnap.exists || orderSnap.data()?.id !== expectedOrderId) {
                logs.error(new Error(`Order ID Mismatch! Possible Notes Injection attempt.`));
                return;
            }

            const dataToWrite: Partial<CheckoutSessionDoc> = {
                status: newStatus,
                updated_at: FieldValue.serverTimestamp(),
            };

            if (existingData?.processing_at) {
                dataToWrite.processing_at = FieldValue.delete() as any;
            }

            tx.set(docRef, dataToWrite as CheckoutSessionDoc, { merge: true });

            if (isPayment && fetchedPayment) {
                tx.set(typedFs.getCheckoutSessionPaymentDoc(uid!, sessionId), fetchedPayment);
            } else if (fetchedOrder) {
                tx.set(orderDocRef, fetchedOrder);
            }
        });

        // --- IDEMPOTENT CALLBACK ---
        // Only trigger the user's custom logic if the database state ACTUALLY changed.
        if (hasStatusChanged && config.onCheckoutSessionUpdate && existingData) {
            try {
                const updatedSession = { ...existingData, status: newStatus, updated_at: FieldValue.serverTimestamp() as any };
                await config.onCheckoutSessionUpdate(uid, updatedSession, fetchedPayment || undefined);
            } catch (err: any) {
                logs.error(new Error(`onCheckoutSessionUpdate error: ${err.message}`));
            }
        }

        logs.webhookProcessed(event.event, fetchedPayment?.id || fetchedOrder?.id || '');
    } catch (error: any) {
        logs.error(error);
        throw error;
    }
};
