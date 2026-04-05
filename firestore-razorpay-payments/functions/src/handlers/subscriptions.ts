import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';
import { getRazorpay } from '../api';

/**
 * Derive and sync custom claims from ALL active subscriptions.
 *
 * Instead of incremental set/remove (which is subject to race conditions
 * and lost-update problems with concurrent webhooks), we query the full
 * subscription state and compute the complete claims map.
 *
 * This is idempotent — concurrent executions converge to the same result
 * because they derive claims from the same committed Firestore state.
 */
export async function syncCustomClaims(
    uid: string,
    db: admin.firestore.Firestore
): Promise<void> {
    if (!config.syncCustomClaims) {
        logs.info(`Custom claims sync disabled. Skipping claim update for user: ${uid}`);
        return;
    }

    try {
        // 1. Query all subscriptions for the user
        const allSubs = await db
            .collection(config.customersCollectionPath)
            .doc(uid)
            .collection('subscriptions')
            .get();

        // 2. Collect roles from active/authenticated subs and track all known roles
        const activeRoles = new Set<string>();
        const allKnownRoles = new Set<string>();

        for (const doc of allSubs.docs) {
            const data = doc.data();
            const role = data.notes?.firebaseRole
                || data.razorpay_notes_firebaseRole
                || data.firebaseRole;
            if (role && typeof role === 'string') {
                allKnownRoles.add(role);
                if (data.status === 'active' || data.status === 'authenticated') {
                    activeRoles.add(role);
                }
            }
        }

        // 3. Read existing claims, preserve non-subscription claims (e.g. 'admin')
        const userRec = await admin.auth().getUser(uid);
        const existingClaims = userRec.customClaims || {};

        const finalClaims: Record<string, any> = {};
        for (const [key, value] of Object.entries(existingClaims)) {
            if (!allKnownRoles.has(key)) {
                finalClaims[key] = value;
            }
        }
        for (const role of activeRoles) {
            finalClaims[role] = true;
        }

        await admin.auth().setCustomUserClaims(uid, finalClaims);
        logs.info(`Synced claims for ${uid}: [${Object.keys(finalClaims).join(', ')}]`);
    } catch (error) {
        // User might have been deleted mid-flight, simply ignore
        logs.error(new Error(`Failed to sync claims for ${uid}: ${error}`));
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
        const role = subscriptionEntity.notes?.firebaseRole ? String(subscriptionEntity.notes?.firebaseRole) : undefined;
        let shouldSetClaims = false;
        let shouldRemoveClaims = false;

        if (newStatus === 'active' || newStatus === 'authenticated') {
            shouldSetClaims = true;
        } else if (newStatus === 'cancelled' || newStatus === 'halted' || newStatus === 'paused' || newStatus === 'completed') {
            shouldRemoveClaims = true;
        }

        // Write atomically
        const dataToWrite: any = {
            subscription_id: subscriptionEntity.id,
            plan_id: subscriptionEntity.plan_id,
            status: newStatus,
            current_start: subscriptionEntity.current_start,
            current_end: subscriptionEntity.current_end,
            total_count: subscriptionEntity.total_count,
            paid_count: subscriptionEntity.paid_count,
            remaining_count: subscriptionEntity.remaining_count,
            charge_at: subscriptionEntity.charge_at,
            short_url: subscriptionEntity.short_url,
            updated_at: FieldValue.serverTimestamp(),
        };

        if (role !== undefined) {
            dataToWrite.firebaseRole = role;
        }

        const batch = db.batch();
        batch.set(docRef, dataToWrite, { merge: true });

        if (paymentEntity) {
            const paymentRef = docRef.collection('payments').doc(paymentEntity.id);
            batch.set(paymentRef, {
                payment_id: paymentEntity.id,
                amount: (paymentEntity as any).amount,
                currency: (paymentEntity as any).currency,
                status: (paymentEntity as any).status,
                method: (paymentEntity as any).method,
                order_id: (paymentEntity as any).order_id,
                updated_at: FieldValue.serverTimestamp(),
            }, { merge: true });
        }
        
        await batch.commit();

        // Sync Custom Claims AFTER the atomic commit succeeds
        if (role && (shouldSetClaims || shouldRemoveClaims)) {
            await syncCustomClaims(uid, db);
        }

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
        throw error; // Let api.ts catch and handle it for retries
    }
};
