import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { logs } from './logs';
import { RazorpaySyncConfig, ProductDoc } from './types';
import { syncPlanToProduct } from './utils';

export const buildCreatePlan = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    return onCall(async (request) => {
        if (!request.auth || request.auth.token.admin !== true) {
            throw new HttpsError(
                'permission-denied',
                'Must be an administrative user to initiate plan creation.'
            );
        }

        const { period, interval, item, notes } = request.data;

        if (!period || !interval || !item || !item.name || !item.amount) {
            throw new HttpsError(
                'invalid-argument',
                'Missing required fields: period, interval, item details.'
            );
        }

        try {
            const plan = await rzp.plans.create({
                period,
                interval,
                item,
                notes
            });

            const db = admin.firestore();
            const productData: ProductDoc = await syncPlanToProduct(plan, db, config);

            logs.info(`Admin created plan: ${plan.id} and synced to product: ${productData.id}`);
            return productData;
        } catch (err: any) {
            logs.error(err);
            throw new HttpsError('internal', 'Failed to create plan.', err.message);
        }
    });
};

export const buildSyncPlans = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    return onCall(async (request) => {
        if (!request.auth || request.auth.token.admin !== true) {
            throw new HttpsError(
                'permission-denied',
                'Must be an administrative user to initiate plan sync.'
            );
        }

        try {
            const db = admin.firestore();
            let syncedCount = 0;
            let skip = 0;
            const count = 100;
            let hasMore = true;

            while (hasMore) {
                const plans = await rzp.plans.all({ skip, count });

                if (plans.items.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const plan of plans.items) {
                    await syncPlanToProduct(plan, db, config);
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
            throw new HttpsError('internal', 'Sync failed.', err.message);
        }
    });
};
