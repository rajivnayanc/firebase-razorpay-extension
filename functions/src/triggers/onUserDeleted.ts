import { FieldValue } from 'firebase-admin/firestore';
import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

const db = admin.firestore();

/**
 * Cleans up Razorpay subscription data and removes custom claims
 * when a customer document is deleted from Firestore.
 *
 * This mirrors Stripe's `onCustomerDataDeleted` pattern — ensuring
 * no orphaned subscription docs or stale custom claims remain.
 */
export const onUserDeleted = functions.firestore
    .document(`${config.customersCollectionPath}/{uid}`)
    .onDelete(async (snap, context) => {
        const uid = context.params.uid;
        logs.info(`Customer document deleted for user ${uid}. Cleaning up...`);

        try {
            // 1. Mark all active subscriptions as cancelled
            const subscriptionsSnap = await db
                .collection(config.customersCollectionPath)
                .doc(uid)
                .collection('subscriptions')
                .where('status', 'in', ['active', 'created', 'authenticated'])
                .get();

            const batch = db.batch();
            subscriptionsSnap.forEach((doc) => {
                batch.update(doc.ref, {
                    status: 'cancelled',
                    ended_at: FieldValue.serverTimestamp(),
                });
            });

            if (!subscriptionsSnap.empty) {
                await batch.commit();
                logs.info(
                    `Cancelled ${subscriptionsSnap.size} active subscription(s) for user ${uid}`
                );
            }

            // 2. Remove custom claims dynamically
            try {
                const user = await admin.auth().getUser(uid);
                if (user.customClaims) {
                    const rolesToRemove = new Set<string>();
                    subscriptionsSnap.forEach((doc) => {
                        const role = doc.data().notes?.firebaseRole || doc.data().razorpay_notes_firebaseRole;
                        if (role) rolesToRemove.add(role);
                    });

                    if (rolesToRemove.size > 0) {
                        const remainingClaims = { ...user.customClaims };
                        let claimsModified = false;

                        rolesToRemove.forEach(role => {
                            if (remainingClaims[role]) {
                                delete remainingClaims[role];
                                claimsModified = true;
                            }
                        });

                        if (claimsModified) {
                            await admin.auth().setCustomUserClaims(uid, remainingClaims);
                            logs.info(`Removed custom claims [${Array.from(rolesToRemove).join(', ')}] for user ${uid}`);
                        }
                    }
                }
            } catch (authError: any) {
                // User may already be deleted from Auth
                if (authError.code !== 'auth/user-not-found') {
                    throw authError;
                }
                logs.info(
                    `User ${uid} already deleted from Auth, skipping claims cleanup`
                );
            }

            logs.info(`Cleanup complete for user ${uid}`);
        } catch (error) {
            logs.error(`Error cleaning up user ${uid}`, error);
        }
    }
    );
