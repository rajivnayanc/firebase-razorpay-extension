import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';

export const handleSubscriptionEvent = async (event: any) => {
    const db = admin.firestore();
    const subscriptionEntity = event.payload.subscription?.entity;

    if (!subscriptionEntity) return;

    const uid = subscriptionEntity.notes?.uid;
    if (!uid) {
        logs.error(new Error(`No UID found in subscription notes for ${subscriptionEntity.id}`));
        return;
    }

    // Path: customers/{uid}/subscriptions/{sub_id}
    const docRef = db.collection(config.customersCollectionPath).doc(uid).collection('subscriptions').doc(subscriptionEntity.id);

    try {
        // Transactional idempotency check could be here if needed for exact balance.
        // For sync we just set merge: true
        const dataToWrite = {
            ...subscriptionEntity,
            _razorpay_event: event.event,
        };

        await docRef.set(dataToWrite, { merge: true });

        // Manage Custom Claims (e.g. firebaseRole from notes)
        if (event.event === 'subscription.activated' || event.event === 'subscription.charged') {
            const role = subscriptionEntity.notes?.firebaseRole;
            if (role) {
                await admin.auth().setCustomUserClaims(uid, { [role]: true });
            }
        } else if (event.event === 'subscription.cancelled' || event.event === 'subscription.halted') {
            const role = subscriptionEntity.notes?.firebaseRole;
            if (role) {
                // Find existing claims and remove the role claim
                const userRec = await admin.auth().getUser(uid);
                const currentClaims = userRec.customClaims || {};
                if (currentClaims[role]) {
                    delete currentClaims[role];
                    await admin.auth().setCustomUserClaims(uid, currentClaims);
                }
            }
        }

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
    }
};
