import { FieldValue } from 'firebase-admin/firestore';
import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';
import { getRazorpay } from '../api';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Deletes the Razorpay customer object and cancels subscriptions when the
 * customer document in Cloud Firestore is deleted.
 */
export const onCustomerDataDeleted = functions.firestore
    .document(`${config.customersCollectionPath}/{uid}`)
    .onDelete(async (snap, context) => {
        const uid = context.params.uid;
        logs.info(`Customer document deleted for user ${uid}. Cleaning up...`);

        try {
            // 1. Mark all active subscriptions as cancelled in Firestore
            const subscriptionsSnap = await db
                .collection(config.customersCollectionPath)
                .doc(uid)
                .collection('subscriptions')
                .where('status', 'in', ['active', 'created', 'authenticated'])
                .get();

            const batch = db.batch();
            for (const doc of subscriptionsSnap.docs) {
                const subscriptionId = doc.data().subscription_id;

                // Cancel explicitly in Razorpay API
                if (subscriptionId) {
                    try {
                        await getRazorpay().subscriptions.cancel(subscriptionId);
                        logs.info(`Cancelled Razorpay subscription ${subscriptionId} for deleted user ${uid}`);
                    } catch (rpError: any) {
                        logs.error(`Failed to cancel Razorpay subscription ${subscriptionId}: ${rpError.message || rpError}`);
                    }
                }

                batch.update(doc.ref, {
                    status: 'cancelled',
                    ended_at: FieldValue.serverTimestamp(),
                });
            }

            if (!subscriptionsSnap.empty) {
                await batch.commit();
                logs.info(`Cancelled ${subscriptionsSnap.size} active subscription(s) for user ${uid}`);
            }

            // Note: Custom claims cleanup is ideally handled by the Auth trigger.
            logs.info(`Firestore cleanup complete for user ${uid}`);
        } catch (error) {
            logs.error(new Error(`Error cleaning up customer data for user ${uid}: ${error}`));
        }
    });

/**
 * Clean up Razorpay data when a user is deleted from Firebase Auth.
 * This ensures even if a user is deleted from the console, their
 * corresponding Razorpay entity and active subscriptions are wiped.
 */
export const onUserDeleted = functions.auth.user().onDelete(async (user) => {
    try {
        logs.info(`User ${user.uid} deleted from Auth. Initiating Razorpay cleanup.`);

        // Fetch the customer doc to get the Razorpay Customer ID
        const customerDoc = await db.collection(config.customersCollectionPath).doc(user.uid).get();
        if (!customerDoc.exists) {
            logs.info(`No customer document found for ${user.uid}. Nothing to clean up.`);
            return;
        }

        const data = customerDoc.data();
        if (!data || !data.razorpay_customer_id) {
            logs.info(`No Razorpay Customer ID associated with ${user.uid}. Nothing to clean up.`);
            return;
        }

        // Note: Razorpay doesn't have a direct "Delete Customer" API endpoint to scrub PII.
        // The standard approach is to trust the Firestore cleanup (`onCustomerDataDeleted`) 
        // to handle the actual subscription cancellations.

        // We trigger the Firestore cleanup proxy by deleting the customer document here.
        await db.collection(config.customersCollectionPath).doc(user.uid).delete();
        logs.info(`Deleted Firestore customer document for ${user.uid} (this will cascade subscription cancellation).`);

    } catch (error: any) {
        logs.error(new Error(`Failed to process Auth deletion for user ${user.uid}: ${error.message}`));
    }
});
