import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';

export const handleProductEvent = async (event: any) => {
    const db = admin.firestore();

    // Note: Razorpay uses 'item' for products and 'plan' for subscriptions. 
    // We sync both to the products collection per Stripe extension behavior
    const entityName = event.event.split('.')[0];
    const payloadEntity = event.payload[entityName]?.entity;

    if (!payloadEntity) return;

    const docRef = db.collection(config.productsCollectionPath).doc(payloadEntity.id);
    const eventName = event.event;

    try {
        if (eventName === 'item.deleted') {
            await docRef.delete();
            logs.webhookProcessed(event.event, payloadEntity.id);
            return;
        }

        // Map the shape
        const dataToWrite = {
            ...payloadEntity,
            _razorpay_event: event.event,
        };

        // Upsert the document
        await docRef.set(dataToWrite, { merge: true });
        logs.webhookProcessed(event.event, payloadEntity.id);
    } catch (error: any) {
        logs.error(error);
    }
};
