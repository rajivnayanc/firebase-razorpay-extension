import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import Razorpay from 'razorpay';
import { logs } from '@/logs';
import { RazorpaySyncConfig } from '@/types';

export const buildCancelSubscription = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    return onCall(async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError('unauthenticated', 'User must be authenticated to cancel a subscription');
        }

        const { subscriptionId } = request.data;
        if (!subscriptionId) {
            throw new HttpsError('invalid-argument', 'The "subscriptionId" must be provided');
        }

        const db = admin.firestore();
        const docRef = db.collection(config.customersCollection)
            .doc(uid)
            .collection('subscriptions')
            .doc(subscriptionId);

        const doc = await docRef.get();
        if (!doc.exists) {
            throw new HttpsError('not-found', 'Subscription not found');
        }

        try {
            const cancelledSubscription = await rzp.subscriptions.cancel(subscriptionId);

            await docRef.set({
                status: cancelledSubscription.status,
                updated_at: FieldValue.serverTimestamp()
            }, { merge: true });

            logs.info(`Successfully cancelled subscription ${subscriptionId} for user ${uid}`);
            return { status: cancelledSubscription.status };
        } catch (error: any) {
            logs.error(new Error(`Failed to cancel subscription ${subscriptionId}: ${error.message}`));
            throw new HttpsError('internal', `Failed to cancel subscription: ${error.message}`);
        }
    });
};

export const buildUpdateSubscriptionPlan = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    return onCall(async (request) => {
        const uid = request.auth?.uid;
        if (!uid) {
            throw new HttpsError('unauthenticated', 'User must be authenticated to update a subscription');
        }

        const { subscriptionId, planId } = request.data;
        if (!subscriptionId || !planId) {
            throw new HttpsError('invalid-argument', 'Both "subscriptionId" and "planId" must be provided');
        }

        const db = admin.firestore();
        const docRef = db.collection(config.customersCollection)
            .doc(uid)
            .collection('subscriptions')
            .doc(subscriptionId);

        const doc = await docRef.get();
        if (!doc.exists) {
            throw new HttpsError('not-found', 'Subscription not found');
        }

        try {
            const updatedSubscription = await rzp.subscriptions.update(subscriptionId, {
                plan_id: planId,
                schedule_change_at: 'now'
            });

            await docRef.set({
                plan_id: updatedSubscription.plan_id,
                status: updatedSubscription.status,
                updated_at: FieldValue.serverTimestamp()
            }, { merge: true });

            logs.info(`Successfully updated subscription ${subscriptionId} for user ${uid} to plan ${planId}`);
            return { plan_id: updatedSubscription.plan_id, status: updatedSubscription.status };
        } catch (error: any) {
            logs.error(new Error(`Failed to update subscription ${subscriptionId}: ${error.message}`));
            throw new HttpsError('internal', `Failed to update subscription: ${error.message}`);
        }
    });
};
