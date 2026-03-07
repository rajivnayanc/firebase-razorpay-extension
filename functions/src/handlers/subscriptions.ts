import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';
import { isValidSubscriptionTransition, isTerminalSubscriptionStatus } from '../stateMachine';

/**
 * Serialize custom claims updates per user using a Firestore document lock.
 * This prevents race conditions when two subscription events try to modify
 * claims for the same user simultaneously.
 */
async function updateCustomClaimsWithLock(
    db: admin.firestore.Firestore,
    uid: string,
    operation: 'set' | 'remove',
    role: string
): Promise<void> {
    const lockRef = db.collection('_razorpay_claims_locks').doc(uid);

    await db.runTransaction(async (t) => {
        // Acquire lock (or read existing state)
        // Read lock doc to serialize concurrent claim updates for this user
        await t.get(lockRef);

        // Read fresh claims from Auth
        const userRec = await admin.auth().getUser(uid);
        const currentClaims = { ...(userRec.customClaims || {}) };

        if (operation === 'set') {
            currentClaims[role] = true;
        } else if (operation === 'remove') {
            delete currentClaims[role];
        }

        // Write claims atomically
        await admin.auth().setCustomUserClaims(uid, currentClaims);

        // Update lock timestamp to track last claims update
        t.set(lockRef, {
            lastUpdated: FieldValue.serverTimestamp(),
            lastRole: role,
            lastOperation: operation,
        });
    });
}

export const handleSubscriptionEvent = async (event: any) => {
    const db = admin.firestore();
    const subscriptionEntity = event.payload.subscription?.entity;

    if (!subscriptionEntity) return;

    const uid = subscriptionEntity.notes?.uid;
    if (!uid) {
        logs.error(new Error(`No UID found in subscription notes for ${subscriptionEntity.id}`));
        return;
    }

    // Map Razorpay event to a status
    const statusMap: Record<string, string> = {
        'subscription.activated': 'active',
        'subscription.charged': 'charged',
        'subscription.cancelled': 'cancelled',
        'subscription.halted': 'halted',
        'subscription.updated': subscriptionEntity.status || 'active',
    };
    const newStatus = statusMap[event.event] || subscriptionEntity.status;

    // Path: customers/{uid}/subscriptions/{sub_id}
    const docRef = db.collection(config.customersCollectionPath)
        .doc(uid)
        .collection('subscriptions')
        .doc(subscriptionEntity.id);

    // --- Event Deduplication ---
    const eventId = event.id || `${event.event}_${subscriptionEntity.id}`;
    const dedupRef = db.collection('_razorpay_processed_events').doc(eventId);

    try {
        let shouldSetClaims = false;
        let shouldRemoveClaims = false;

        await db.runTransaction(async (t) => {
            // 1. Deduplication check
            const dedupDoc = await t.get(dedupRef);
            if (dedupDoc.exists) {
                logs.webhookProcessed(event.event, `SKIPPED (duplicate: ${eventId})`);
                return;
            }

            // 2. Read current subscription state
            const subDoc = await t.get(docRef);
            const currentStatus = subDoc.exists ? subDoc.data()?.status : null;

            // 3. Enforce state machine
            if (isTerminalSubscriptionStatus(currentStatus)) {
                logs.webhookProcessed(event.event, `SKIPPED (terminal state: ${currentStatus})`);
                return;
            }

            if (newStatus && !isValidSubscriptionTransition(currentStatus, newStatus)) {
                logs.error(new Error(`Invalid subscription transition: ${currentStatus} → ${newStatus} for ${subscriptionEntity.id}`));
                return;
            }

            // 4. Write atomically
            const dataToWrite = {
                ...subscriptionEntity,
                status: newStatus,
                _razorpay_event: event.event,
                _last_event_id: eventId,
                updated_at: FieldValue.serverTimestamp(),
            };

            t.set(docRef, dataToWrite, { merge: true });
            t.set(dedupRef, {
                processedAt: FieldValue.serverTimestamp(),
                expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7-day TTL
                event: event.event,
                entityId: subscriptionEntity.id,
            });

            // 5. Flag claims changes (execute OUTSIDE main transaction)
            if (event.event === 'subscription.activated' || event.event === 'subscription.charged') {
                shouldSetClaims = true;
            } else if (event.event === 'subscription.cancelled' || event.event === 'subscription.halted') {
                shouldRemoveClaims = true;
            }
        });

        // Manage Custom Claims AFTER successful transaction
        // Uses serialized lock to prevent concurrent claim updates for the same user
        const role = subscriptionEntity.notes?.firebaseRole;
        if (role && shouldSetClaims) {
            await updateCustomClaimsWithLock(db, uid, 'set', role);
        } else if (role && shouldRemoveClaims) {
            await updateCustomClaimsWithLock(db, uid, 'remove', role);
        }

        logs.webhookProcessed(event.event, subscriptionEntity.id);
    } catch (error: any) {
        logs.error(error);
    }
};
