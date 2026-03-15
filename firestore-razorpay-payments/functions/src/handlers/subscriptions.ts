import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';
import { getRazorpay } from '../api';

/**
 * Manage custom claims updates sequentially.
 */
async function manageCustomClaims(
    uid: string,
    operation: 'set' | 'remove',
    role: string
): Promise<void> {
    try {
        const userRec = await admin.auth().getUser(uid);
        const currentClaims = { ...(userRec.customClaims || {}) };

        if (operation === 'set') {
            currentClaims[role] = true;
        } else if (operation === 'remove') {
            delete currentClaims[role];
        }

        await admin.auth().setCustomUserClaims(uid, currentClaims);
    } catch (error) {
        // User might have been deleted mid-flight, simply ignore
        logs.error(new Error(`Failed to update claims for ${uid}: ${error}`));
    }
}

export const handleSubscriptionEvent = async (event: any) => {
    const db = admin.firestore();
    const webhookSubscription = event.payload.subscription?.entity;

    if (!webhookSubscription?.id) {
        logs.error(new Error(`Missing subscription entity or ID in webhook payload: ${event.id}`));
        return;
    }

    let subscriptionEntity;
    try {
        // FETCH latest state from Razorpay API as source of truth
        subscriptionEntity = await getRazorpay().subscriptions.fetch(webhookSubscription.id);
    } catch (err: any) {
        logs.error(new Error(`Failed to fetch subscription from Razorpay API: ${webhookSubscription.id}. Error: ${err.message}`));
        return;
    }

    const uid = String(subscriptionEntity.notes?.uid);
    if (!uid || uid === 'undefined') {
        logs.error(new Error(`No UID found in subscription notes for ${subscriptionEntity.id}`));
        return;
    }

    // Use the fetched subscription status directly
    const newStatus = String(subscriptionEntity.status);

    // Use the original Firestore document ID if it was passed in the subscription notes
    // This prevents creating duplicate documents (Razorpay ID vs Auto-ID)
    let subscriptionId = subscriptionEntity.notes?.subscriptionId ? String(subscriptionEntity.notes?.subscriptionId) : undefined;
    let docRef: admin.firestore.DocumentReference;

    if (subscriptionId) {
        docRef = db.collection(config.customersCollectionPath)
            .doc(uid)
            .collection('subscriptions')
            .doc(subscriptionId);
    } else {
        // FALLBACK: If notes are missing, try to find the document by the Razorpay ID field
        const subQuery = await db.collection(config.customersCollectionPath)
            .doc(uid)
            .collection('subscriptions')
            .where('subscription_id', '==', subscriptionEntity.id)
            .limit(1)
            .get();

        if (!subQuery.empty) {
            docRef = subQuery.docs[0].ref;
            subscriptionId = docRef.id;
        } else {
            // Last resort: use the Razorpay ID as the doc ID (will create new doc)
            subscriptionId = subscriptionEntity.id;
            docRef = db.collection(config.customersCollectionPath)
                .doc(uid)
                .collection('subscriptions')
                .doc(subscriptionId);
        }
    }

    // If there's a payment attached to the webhook, fetch its authoritative state
    let paymentEntity = null;
    const webhookPayment = event.payload.payment?.entity || (event.payload.payment?.id ? event.payload.payment : null);
    if (webhookPayment?.id) {
        try {
            paymentEntity = await getRazorpay().payments.fetch(webhookPayment.id);
        } catch (err: any) {
            logs.error(new Error(`Failed to fetch payment from Razorpay API: ${webhookPayment.id}. Error: ${err.message}`));
            // We can continue with the subscription update even if payment fetch fails
        }
    }

    try {
        let shouldSetClaims = false;
        let shouldRemoveClaims = false;

        // Ensure we handle claims based on the fetched status
        if (newStatus === 'active' || newStatus === 'authenticated') {
            shouldSetClaims = true;
        } else if (newStatus === 'cancelled' || newStatus === 'halted' || newStatus === 'paused' || newStatus === 'completed') {
            shouldRemoveClaims = true;
        }

        // Manage Custom Claims BEFORE the transaction
        const role = subscriptionEntity.notes?.firebaseRole ? String(subscriptionEntity.notes?.firebaseRole) : undefined;
        if (role && shouldSetClaims) {
            await manageCustomClaims(uid, 'set', role);
        } else if (role && shouldRemoveClaims) {
            await manageCustomClaims(uid, 'remove', role);
        }

        // Write atomically
        const dataToWrite = {
            ...subscriptionEntity,
            status: newStatus,
            updated_at: FieldValue.serverTimestamp(),
        };

        const batch = db.batch();
        batch.set(docRef, dataToWrite, { merge: true });

        // Record payment history if we fetched a payment
        if (paymentEntity) {
            const paymentRef = docRef.collection('payments').doc(paymentEntity.id);
            batch.set(paymentRef, {
                ...paymentEntity,
                updated_at: FieldValue.serverTimestamp(),
            }, { merge: true });
        }

        await batch.commit();

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
    }
};
