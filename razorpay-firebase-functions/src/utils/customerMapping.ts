import * as admin from 'firebase-admin';

/**
 * Look up a Firebase UID using the strictly mapped Razorpay Customer ID.
 * This prevents notes.uid spoofing by enforcing a server-side verified mapping.
 */
export async function getUidByCustomerId(
    customerId: string,
    customersCollectionPath: string
): Promise<string | null> {
    if (!customerId) return null;
    
    const db = admin.firestore();
    const snap = await db.collection(customersCollectionPath)
        .where('razorpay_customer_id', '==', customerId)
        .limit(1)
        .get();

    if (snap.empty) {
        return null;
    }

    return snap.docs[0].id;
}
