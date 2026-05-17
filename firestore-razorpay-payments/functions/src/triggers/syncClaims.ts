import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import config from '../config';
import { logs } from '../logs';

export const syncClaimsHandler = async (event: any) => {
    if (!config.syncCustomClaims) {
        return;
    }

    const uid = event.params.uid;
    
    try {
        // 1. Read ALL subscriptions for this user from Firestore to determine
        // all roles ever managed by Razorpay, and which ones are currently active.
        const allSubsSnap = await admin.firestore()
            .collection(config.customersCollectionPath)
            .doc(uid)
            .collection('subscriptions')
            .get();

        const activeRoles = new Set<string>();
        const allRazorpayRoles = new Set<string>();

        allSubsSnap.forEach(doc => {
            const data = doc.data();
            const role = data.firebaseRole;
            const status = data.status;

            if (role && typeof role === 'string') {
                allRazorpayRoles.add(role);
                if (status === 'active' || status === 'authenticated') {
                    activeRoles.add(role);
                }
            }
        });

        // 2. Get existing claims to preserve non-Razorpay roles (like 'admin')
        const userRec = await admin.auth().getUser(uid);
        const mergedClaims: Record<string, any> = { ...(userRec.customClaims || {}) };

        let updated = false;

        // Remove any Razorpay role that is no longer active
        allRazorpayRoles.forEach(role => {
            if (!activeRoles.has(role) && mergedClaims[role]) {
                delete mergedClaims[role];
                updated = true;
            }
        });

        // Add any Razorpay role that is active
        activeRoles.forEach(role => {
            if (!mergedClaims[role]) {
                mergedClaims[role] = true;
                updated = true;
            }
        });

        // 3. Write the computed state atomically to Auth
        if (updated) {
            await admin.auth().setCustomUserClaims(uid, mergedClaims);
            logs.info(`Synced claims for ${uid}: [${Object.keys(mergedClaims).join(', ')}]`);
        }
    } catch (error: any) {
        // User might have been deleted mid-flight or auth fetch failed, log and ignore
        logs.error(new Error(`Failed to sync claims for ${uid}: ${error.message}`));
    }
};

export const syncClaimsOnSubscriptionChange = onDocumentWritten(
    `${config.customersCollectionPath}/{uid}/subscriptions/{subscriptionId}`,
    syncClaimsHandler
);
