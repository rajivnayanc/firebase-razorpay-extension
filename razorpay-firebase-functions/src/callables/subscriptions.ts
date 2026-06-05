import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import Razorpay from 'razorpay';
import { logs } from '../logs';
import { RazorpaySyncConfig, SubscriptionDoc } from '../types';
import { TypedFirestore } from '../utils/typedFirestore';

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
        const typedFs = new TypedFirestore(db, config);
        const docRef = typedFs.getSubscriptionDoc(uid, subscriptionId);

        const doc = await docRef.get();
        if (!doc.exists) {
            throw new HttpsError('not-found', 'Subscription not found');
        }

        const existingData = doc.data();
        if (existingData?.status === 'cancelled' || existingData?.status === 'completed') {
            throw new HttpsError('failed-precondition', 'Subscription is already cancelled or completed.');
        }

        try {
            const cancelledSubscription = await rzp.subscriptions.cancel(subscriptionId);

            // Update main document status & timestamps only
            const updateData: Partial<SubscriptionDoc> = {
                status: cancelledSubscription.status,
                updated_at: FieldValue.serverTimestamp()
            };
            await docRef.set(updateData as SubscriptionDoc, { merge: true });

            // Save raw subscription response separately
            const detailsDocRef = typedFs.getSubscriptionDetailsDoc(uid, subscriptionId);
            await detailsDocRef.set(cancelledSubscription);

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

        const { subscriptionId, planId, scheduleChangeAt } = request.data;
        if (!subscriptionId || !planId) {
            throw new HttpsError('invalid-argument', 'Both "subscriptionId" and "planId" must be provided');
        }

        // Only allow known-safe values for schedule_change_at
        const validSchedule = scheduleChangeAt === 'cycle_end' ? 'cycle_end' : 'now';

        const db = admin.firestore();
        const typedFs = new TypedFirestore(db, config);
        const docRef = typedFs.getSubscriptionDoc(uid, subscriptionId);

        const doc = await docRef.get();
        if (!doc.exists) {
            throw new HttpsError('not-found', 'Subscription not found');
        }

        // SEC-07: Validate that the planId is valid and belongs to an active product
        const productsSnap = await typedFs.getProductsCollection()
            .where('active', '==', true)
            .get();

        const isAllowed = productsSnap.docs.some(productDoc => {
            const data = productDoc.data();
            return data.allowedPlans && Object.values(data.allowedPlans).includes(planId);
        });

        if (!isAllowed) {
            throw new HttpsError('invalid-argument', 'The specified plan is not available.');
        }

        try {
            const updatedSubscription = await rzp.subscriptions.update(subscriptionId, {
                plan_id: planId,
                schedule_change_at: validSchedule
            });

            // Update main document status & timestamps only
            const updateData: Partial<SubscriptionDoc> = {
                status: updatedSubscription.status,
                updated_at: FieldValue.serverTimestamp()
            };
            await docRef.set(updateData as SubscriptionDoc, { merge: true });

            // Save raw subscription response separately
            const detailsDocRef = typedFs.getSubscriptionDetailsDoc(uid, subscriptionId);
            await detailsDocRef.set(updatedSubscription);

            logs.info(`Successfully updated subscription ${subscriptionId} for user ${uid} to plan ${planId}`);
            return { plan_id: updatedSubscription.plan_id, status: updatedSubscription.status };
        } catch (error: any) {
            logs.error(new Error(`Failed to update subscription ${subscriptionId}: ${error.message}`));
            throw new HttpsError('internal', `Failed to update subscription: ${error.message}`);
        }
    });
};
