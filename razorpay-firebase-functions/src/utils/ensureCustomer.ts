import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { logs } from '../logs';
import { RazorpaySyncConfig } from '../types';

/**
 * Ensures a Razorpay customer exists for the given Firebase UID.
 * If no customer is linked and syncCustomers is enabled, creates one via the Razorpay API
 * and stores the mapping in Firestore.
 *
 * @returns The Razorpay customer ID, or null if not found and creation is disabled/failed.
 */
export async function ensureRazorpayCustomer(
    uid: string,
    config: RazorpaySyncConfig,
    rzp: Razorpay
): Promise<string | null> {
    const db = admin.firestore();
    const customerDoc = await db.collection(config.customersCollection).doc(uid).get();
    const customerData = customerDoc.data() || {};
    const existingCustomerId = customerData.razorpay_customer_id;

    if (existingCustomerId) {
        return existingCustomerId;
    }

    if (!config.syncCustomers) {
        logs.info(`No linked Razorpay customer ID for UID ${uid} and syncCustomers is disabled.`);
        return null;
    }

    const userRec = await admin.auth().getUser(uid).catch(() => null);
    const newCustomer = await rzp.customers.create({
        name: userRec?.displayName || customerData.name || 'Firebase User',
        email: userRec?.email || customerData.email || undefined,
        contact: userRec?.phoneNumber || customerData.phone || undefined,
        fail_existing: '0',
    } as any);

    const razorpayCustomerId = newCustomer.id;
    await customerDoc.ref.set({ razorpay_customer_id: razorpayCustomerId }, { merge: true });
    logs.info(`Created Razorpay customer ${razorpayCustomerId} for UID ${uid}`);

    return razorpayCustomerId;
}
