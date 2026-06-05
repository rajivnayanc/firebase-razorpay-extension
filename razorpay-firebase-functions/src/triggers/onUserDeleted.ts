import { FieldValue } from 'firebase-admin/firestore';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { logs } from '@/logs';
import { RazorpaySyncConfig } from '@/types';

export const buildOnCustomerDataDeleted = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    return functions.firestore
        .document(`${config.customersCollection}/{uid}`)
        .onDelete(async (snapshot, context) => {
            const uid = context.params.uid;
            const db = admin.firestore();
            logs.info(`Customer document deleted for user ${uid}. Cleaning up...`);

            try {
                const subscriptionsSnap = await db
                    .collection(config.customersCollection)
                    .doc(uid)
                    .collection('subscriptions')
                    .where('status', 'in', ['active', 'created', 'authenticated'])
                    .get();

                const batch = db.batch();
                for (const doc of subscriptionsSnap.docs) {
                    const subscriptionId = doc.data().subscription_id;

                    if (subscriptionId) {
                        try {
                            await rzp.subscriptions.cancel(subscriptionId);
                            logs.info(`Cancelled Razorpay subscription ${subscriptionId} for deleted user ${uid}`);

                            batch.update(doc.ref, {
                                status: 'cancelled',
                                ended_at: FieldValue.serverTimestamp(),
                            });
                        } catch (rpError: any) {
                            logs.error(`Failed to cancel Razorpay subscription ${subscriptionId}: ${rpError.message || rpError}`);
                        }
                    } else {
                        batch.update(doc.ref, {
                            status: 'cancelled',
                            ended_at: FieldValue.serverTimestamp(),
                        });
                    }
                }

                if (!subscriptionsSnap.empty) {
                    await batch.commit();
                    logs.info(`Cancelled ${subscriptionsSnap.size} active subscription(s) for user ${uid}`);
                }

                logs.info(`Firestore cleanup complete for user ${uid}`);
            } catch (error) {
                logs.error(new Error(`Error cleaning up customer data for user ${uid}: ${error}`));
            }
        });
};

export const buildOnUserDeleted = (config: RazorpaySyncConfig) => {
    return functions.auth.user().onDelete(async (user) => {
        if (!config.syncCustomers) {
            logs.info(`Customer sync disabled. Skipping automatic cleanup for user: ${user.uid}`);
            return;
        }

        try {
            const db = admin.firestore();
            logs.info(`User ${user.uid} deleted from Auth. Initiating Razorpay cleanup.`);

            const customerDoc = await db.collection(config.customersCollection).doc(user.uid).get();
            if (!customerDoc.exists) {
                logs.info(`No customer document found for ${user.uid}. Nothing to clean up.`);
                return;
            }

            const data = customerDoc.data();
            if (!data || !data.razorpay_customer_id) {
                logs.info(`No Razorpay Customer ID associated with ${user.uid}. Nothing to clean up.`);
                return;
            }

            await db.collection(config.customersCollection).doc(user.uid).delete();
            logs.info(`Deleted Firestore customer document for ${user.uid} (this will cascade subscription cancellation).`);

        } catch (error: any) {
            logs.error(new Error(`Failed to process Auth deletion for user ${user.uid}: ${error.message}`));
        }
    });
};
