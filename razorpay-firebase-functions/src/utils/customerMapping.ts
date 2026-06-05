import * as admin from 'firebase-admin';
import { TypedFirestore } from './typedFirestore';

/**
 * Look up a Firebase UID using the strictly mapped Razorpay Customer ID.
 * This prevents notes.uid spoofing by enforcing a server-side verified mapping.
 * 
 * NOTE: For production scale, you must create a single-field index in Firestore
 * on the customers collection's `razorpay_customer_id` field (or a collection group index)
 * to avoid full collection scans and ensure O(1) performance.
 */
export async function getUidByCustomerId(
    customerId: string,
    customersCollectionPath: string
): Promise<string | null> {
    if (!customerId) return null;
    
    const db = admin.firestore();
    const typedFs = new TypedFirestore(db, {
        customersCollection: customersCollectionPath,
        productsCollection: '',
        keyId: '',
        keySecret: '',
        webhookSecret: '',
        syncCustomers: true
    });

    const snap = await typedFs.getCustomersCollection()
        .where('razorpay_customer_id', '==', customerId)
        .limit(1)
        .get();

    if (snap.empty) {
        return null;
    }

    return snap.docs[0].id;
}
