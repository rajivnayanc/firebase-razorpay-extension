import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';

export const handlePaymentEvent = async (event: any) => {
    const db = admin.firestore();
    const paymentEntity = event.payload.payment?.entity;
    const orderEntity = event.payload.order?.entity;

    // We rely on order properties being passed down via notes during createOrder
    const notes = orderEntity?.notes || paymentEntity?.notes;
    const uid = notes?.uid;
    const sessionId = notes?.sessionId;

    if (!uid || !sessionId) {
        // If there's no mapping to our Firestore structure, simply ignore or log
        return;
    }

    // Path: customers/{uid}/checkout_sessions/{id}
    const docRef = db.collection(config.customersCollectionPath).doc(uid).collection('checkout_sessions').doc(sessionId);

    try {
        const dataToWrite: any = {
            status: event.event === 'payment.captured' || event.event === 'order.paid' ? 'paid' : event.event === 'payment.failed' ? 'failed' : 'processing',
            _razorpay_event: event.event,
        };

        if (paymentEntity) {
            dataToWrite.payment_id = paymentEntity.id;
        }

        // Use transaction for money idempotency if strictly needed,
        // but just updating state here is fine for the session sync
        await docRef.set(dataToWrite, { merge: true });
        logs.webhookProcessed(event.event, paymentEntity?.id || orderEntity?.id);
    } catch (error: any) {
        logs.error(error);
    }
};
