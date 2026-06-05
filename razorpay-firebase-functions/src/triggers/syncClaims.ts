import { onDocumentWritten } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import { logs } from '../logs';
import { RazorpaySyncConfig } from '../types';

export const buildSyncClaimsOnSubscriptionChange = (config: RazorpaySyncConfig) => {
    const syncClaimsHandler = async (event: any) => {
        if (!config.syncCustomClaims) {
            return;
        }

        const uid = event.params.uid;
        
        try {
            const allSubsSnap = await admin.firestore()
                .collection(config.customersCollection)
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

            const userRec = await admin.auth().getUser(uid);
            const mergedClaims: Record<string, any> = { ...(userRec.customClaims || {}) };

            let updated = false;

            allRazorpayRoles.forEach(role => {
                if (!activeRoles.has(role) && mergedClaims[role]) {
                    delete mergedClaims[role];
                    updated = true;
                }
            });

            activeRoles.forEach(role => {
                if (!mergedClaims[role]) {
                    mergedClaims[role] = true;
                    updated = true;
                }
            });

            if (updated) {
                await admin.auth().setCustomUserClaims(uid, mergedClaims);
                logs.info(`Synced claims for ${uid}: [${Object.keys(mergedClaims).join(', ')}]`);
            }
        } catch (error: any) {
            logs.error(new Error(`Failed to sync claims for ${uid}: ${error.message}`));
        }
    };

    return onDocumentWritten(
        `${config.customersCollection}/{uid}/subscriptions/{subscriptionId}`,
        syncClaimsHandler
    );
};
