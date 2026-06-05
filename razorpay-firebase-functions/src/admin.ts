import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import Razorpay from 'razorpay';
import { logs } from './logs';
import { RazorpaySyncConfig } from './types';
import { sanitizePlan, generateProductId, generatePlanKey } from './utils';

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
            const productId = generateProductId(plan);
            const planKey = generatePlanKey(plan);
            const docRef = db.collection(config.productsCollection).doc(productId);

            const productSnap = await docRef.get();
            const productData = productSnap.data() || {
                id: productId,
                name: plan.item?.name || 'Razorpay Product',
                description: plan.item?.description || '',
                active: true,
                allowedPlans: {},
                created_at: FieldValue.serverTimestamp(),
            };

            productData.allowedPlans = productData.allowedPlans || {};
            productData.allowedPlans[planKey] = plan.id;
            
            productData.plans = productData.plans || {};
            productData.plans[planKey] = sanitizePlan(plan);

            productData.type = 'subscription';
            productData.updated_at = FieldValue.serverTimestamp();
            productData._synced_via = 'admin_api';

            await docRef.set(productData, { merge: true });

            logs.info(`Admin created plan: ${plan.id} and synced to product: ${productId}`);
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
                    const productId = generateProductId(plan);
                    const planKey = generatePlanKey(plan);
                    const docRef = db.collection(config.productsCollection).doc(productId);

                    const productSnap = await docRef.get();
                    const productData = productSnap.data() || {
                        id: productId,
                        name: plan.item?.name || 'Razorpay Product',
                        description: plan.item?.description || '',
                        active: true,
                        allowedPlans: {},
                        created_at: FieldValue.serverTimestamp(),
                    };

                    productData.allowedPlans = productData.allowedPlans || {};
                    productData.allowedPlans[planKey] = plan.id;

                    productData.plans = productData.plans || {};
                    productData.plans[planKey] = sanitizePlan(plan);

                    productData.type = 'subscription';
                    productData.updated_at = FieldValue.serverTimestamp();
                    productData._synced_via = 'admin_api';

                    await docRef.set(productData, { merge: true });
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
