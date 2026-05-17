import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { Orders } from 'razorpay/dist/types/orders';
import { Payments } from 'razorpay/dist/types/payments';
import config from '../config';
import { logs } from '../logs';
import { WebhookEvent } from '../api';

async function fetchWithBackoff<T>(fetchFn: () => Promise<T>, retries = 3, backoffMs = 500): Promise<T> {
    let attempt = 0;
    while (attempt < retries) {
        try {
            return await fetchFn();
        } catch (err: any) {
            attempt++;
            if (err.statusCode === 429 && attempt < retries) {
                logs.info(`Rate limited (429). Retrying in ${backoffMs}ms (Attempt ${attempt} of ${retries})`);
                await new Promise(resolve => setTimeout(resolve, backoffMs));
                backoffMs *= 2;
            } else {
                throw err;
            }
        }
    }
    throw new Error('Max retries reached');
}

export const handlePaymentEvent = async (event: WebhookEvent, db: admin.firestore.Firestore, razorpayClient: InstanceType<typeof Razorpay>) => {
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
            // Fallback: try order first if available
            fetchedEntity = await fetchWithBackoff(() => razorpayClient.orders.fetch(webhookOrderId));
        } else if (webhookPaymentId) {
            // Fallback: target payment if only payment ID is present
            fetchedEntity = await fetchWithBackoff(() => razorpayClient.payments.fetch(webhookPaymentId));
            isPayment = true;
        }
    } catch (err: any) {
        logs.error(new Error(`Failed to fetch entity from Razorpay API. Event: ${event.event}. Error: ${err.message}`));
        return;
    }

    if (!fetchedEntity) {
        logs.error(new Error(`Failed to resolve entity for event: ${event.event}`));
        return;
    }

    // We rely on order properties being passed down via notes during createOrder
    const notes = fetchedEntity.notes;
    const uid = notes?.uid ? String(notes.uid) : undefined;
    const sessionId = notes?.sessionId ? String(notes.sessionId) : undefined;

    if (!uid || !sessionId) {
        // If there's no mapping to our Firestore structure, simply ignore
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

    // Path: customers/{uid}/checkout_sessions/{sessionId}
    const docRef = db.collection(config.customersCollectionPath)
        .doc(uid)
        .collection('checkout_sessions')
        .doc(sessionId);

    try {
        const dataToWrite: any = {
            status: newStatus,
            updated_at: FieldValue.serverTimestamp(),
            processing_at: FieldValue.delete(), // Forcefully clear zombie processing lock
        };

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
        }

        await docRef.set(dataToWrite, { merge: true });

        logs.webhookProcessed(event.event, fetchedEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error; // Let api.ts catch and handle it for retries
    }
};
