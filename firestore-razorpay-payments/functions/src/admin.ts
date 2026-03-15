import * as functions from 'firebase-functions/v1';
import * as admin from 'firebase-admin';
import { getRazorpay } from './api';
import config from './config';
import { logs } from './logs';

// Helper to sanitize plan data
const sanitizePlan = (plan: any) => {
    const sanitizedPlan: any = {
        id: plan.id,
        entity: plan.entity,
        interval: plan.interval,
        period: plan.period,
        item: plan.item,
        notes: plan.notes || {},
        active: true, // Plans don't return an active boolean at the top level
        created_at: plan.created_at,
        updated_at: admin.firestore.FieldValue.serverTimestamp(),
        _synced_via: 'admin_api'
    };

    if (plan.item && (plan.item as any).active !== undefined) {
        sanitizedPlan.active = (plan.item as any).active;
    }

    return sanitizedPlan;
};

// ---------- Admin: Create Plan ----------
export const createPlan = functions.https.onCall(async (data, context) => {
    // 1. Verify Admin Auth
    if (!context.auth || (context.auth.token.admin !== true && context.auth.token.role !== 'admin')) {
        throw new functions.https.HttpsError(
            'permission-denied',
            'Must be an administrative user to initiate plan creation.'
        );
    }

    const { period, interval, item, notes } = data;

    if (!period || !interval || !item || !item.name || !item.amount) {
        throw new functions.https.HttpsError(
            'invalid-argument',
            'Missing required fields: period, interval, item details.'
        );
    }

    try {
        // Create plan in Razorpay
        const plan = await getRazorpay().plans.create({
            period,
            interval,
            item,
            notes
        });

        // Store sanitized plan in Firestore
        const db = admin.firestore();
        const docRef = db.collection(config.productsCollectionPath).doc(plan.id);
        const sanitizedPlan = sanitizePlan(plan);

        await docRef.set(sanitizedPlan, { merge: true });

        logs.info(`Admin created plan: ${plan.id}`);
        return sanitizedPlan;
    } catch (err: any) {
        logs.error(err);
        throw new functions.https.HttpsError('internal', 'Failed to create plan.', err.message);
    }
});

// ---------- Admin: Sync All Plans ----------
export const syncPlans = functions.https.onCall(async (data, context) => {
    // 1. Verify Admin Auth
    if (!context.auth || (context.auth.token.admin !== true && context.auth.token.role !== 'admin')) {
        throw new functions.https.HttpsError(
            'permission-denied',
            'Must be an administrative user to initiate plan sync.'
        );
    }

    try {
        const db = admin.firestore();
        let syncedCount = 0;
        let skip = 0;
        const count = 100; // max pagination count
        let hasMore = true;

        while (hasMore) {
            const plans = await getRazorpay().plans.all({ skip, count });

            if (plans.items.length === 0) {
                hasMore = false;
                break;
            }

            for (const plan of plans.items) {
                const docRef = db.collection(config.productsCollectionPath).doc(plan.id);
                const sanitizedPlan = sanitizePlan(plan);

                await docRef.set(sanitizedPlan, { merge: true });
                syncedCount++;
            }

            skip += count;
            if (plans.items.length < count) {
                hasMore = false;
            }
        }

        logs.info(`Admin synced ${syncedCount} plans successfully.`);
        return { status: 'SUCCESS', count: syncedCount };
    } catch (err: any) {
        logs.error(err);
        throw new functions.https.HttpsError('internal', 'Sync failed.', err.message);
    }
});
