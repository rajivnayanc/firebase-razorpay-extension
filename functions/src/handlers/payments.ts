import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';
import { isValidSessionTransition, isTerminalSessionStatus } from '../stateMachine';

export const handlePaymentEvent = async (event: any) => {
    const db = admin.firestore();
    const paymentEntity = event.payload.payment?.entity;
    const orderEntity = event.payload.order?.entity;

    // We rely on order properties being passed down via notes during createOrder
    const notes = orderEntity?.notes || paymentEntity?.notes;
    const uid = notes?.uid;
    const sessionId = notes?.sessionId;

    if (!uid || !sessionId) {
        // If there's no mapping to our Firestore structure, simply ignore
        return;
    }

    const newStatus = (event.event === 'payment.captured' || event.event === 'order.paid')
        ? 'paid'
        : event.event === 'payment.failed'
            ? 'failed'
            : 'processing';

    // Path: customers/{uid}/checkout_sessions/{id}
    const docRef = db.collection(config.customersCollectionPath)
        .doc(uid)
        .collection('checkout_sessions')
        .doc(sessionId);

    // --- Event Deduplication ---
    const eventId = event.id || `${event.event}_${paymentEntity?.id || orderEntity?.id}`;
    const dedupRef = db.collection('_razorpay_processed_events').doc(eventId);

    try {
        await db.runTransaction(async (t) => {
            // 1. Check if this exact event was already processed
            const dedupDoc = await t.get(dedupRef);
            if (dedupDoc.exists) {
                logs.webhookProcessed(event.event, `SKIPPED (duplicate: ${eventId})`);
                return;
            }

            // 2. Read current session state
            const sessionDoc = await t.get(docRef);
            const currentStatus = sessionDoc.exists ? sessionDoc.data()?.status : null;

            // 3. Enforce state machine — reject invalid transitions
            if (isTerminalSessionStatus(currentStatus)) {
                logs.webhookProcessed(event.event, `SKIPPED (terminal state: ${currentStatus})`);
                return;
            }

            if (!isValidSessionTransition(currentStatus, newStatus)) {
                logs.error(new Error(`Invalid state transition: ${currentStatus} → ${newStatus} for session ${sessionId}`));
                return;
            }

            // 4. Write atomically
            const dataToWrite: any = {
                status: newStatus,
                _razorpay_event: event.event,
                _last_event_id: eventId,
                updated_at: admin.firestore.FieldValue.serverTimestamp(),
            };

            if (paymentEntity) {
                dataToWrite.payment_id = paymentEntity.id;
            }

            t.set(docRef, dataToWrite, { merge: true });
            t.set(dedupRef, {
                processedAt: admin.firestore.FieldValue.serverTimestamp(),
                event: event.event,
                entityId: paymentEntity?.id || orderEntity?.id,
            });
        });

        logs.webhookProcessed(event.event, paymentEntity?.id || orderEntity?.id);
    } catch (error: any) {
        logs.error(error);
    }
};
