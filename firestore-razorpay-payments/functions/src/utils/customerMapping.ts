import * as admin from 'firebase-admin';
import config from '../config';

/**
 * Look up a Firebase UID using the strictly mapped Razorpay Customer ID.
 * This prevents notes.uid spoofing by enforcing a server-side verified mapping.
 */
export async function getUidByCustomerId(customerId: string): Promise<string | null> {
    if (!customerId) return null;
    
    const db = admin.firestore();
    const snap = await db.collection(config.customersCollectionPath)
        .where('razorpay_customer_id', '==', customerId)
        .limit(1)
        .get();

    if (snap.empty) {
        return null;
    }

    return snap.docs[0].id;
}
