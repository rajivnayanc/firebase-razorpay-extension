import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';

const PROCESSING_TIMEOUT_MS = 120_000; // 2 minutes

/**
 * Acquires a processing lock on a Firestore document via a transaction.
 * Prevents duplicate processing of the same document by multiple function invocations.
 *
 * @param docRef - The Firestore document reference to lock.
 * @param isTerminal - A predicate that returns true if the document is already in a
 *                     terminal state (e.g., has an order_id, subscription_id, or paid status).
 * @returns true if the lock was successfully acquired, false if the document is already
 *          processed or currently being processed within the timeout window.
 */
export async function acquireProcessingLock(
    docRef: admin.firestore.DocumentReference,
    isTerminal: (data: admin.firestore.DocumentData) => boolean
): Promise<boolean> {
    let acquired = false;

    await admin.firestore().runTransaction(async (transaction) => {
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists) return;

        const data = docSnap.data();
        if (!data) return;

        if (isTerminal(data)) {
            acquired = false;
            return;
        }

        if (data.status === 'processing') {
            const processingAt = data.processing_at?.toDate();
            if (processingAt && (Date.now() - processingAt.getTime()) < PROCESSING_TIMEOUT_MS) {
                acquired = false;
                return; // Still processing within timeout window
            }
        }

        transaction.update(docRef, {
            status: 'processing',
            processing_at: FieldValue.serverTimestamp(),
        });
        acquired = true;
    });

    return acquired;
}
