import { onCall, HttpsError } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { getRazorpay } from './api';
import config from './config';
import { logs } from './logs';
import { sanitizePlan, generateProductId, generatePlanKey } from './utils';

// ---------- Admin: Create Plan ----------
export const createPlan = onCall(async (request) => {
    // 1. Verify Admin Auth
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
        // Create plan in Razorpay
        const plan = await getRazorpay().plans.create({
            period,
            interval,
            item,
            notes
        });

        // Store structured plan in Firestore under its Product document
        const db = admin.firestore();
        const productId = generateProductId(plan);
        const planKey = generatePlanKey(plan);
        const docRef = db.collection(config.productsCollectionPath).doc(productId);

        const productSnap = await docRef.get();
        const productData = productSnap.data() || {
            id: productId,
            name: plan.item?.name || 'Razorpay Product',
            description: plan.item?.description || '',
            active: true,
            allowedPlans: {},
            created_at: admin.firestore.FieldValue.serverTimestamp(),
        };

        productData.allowedPlans = productData.allowedPlans || {};
        productData.allowedPlans[planKey] = plan.id;
        
        productData.plans = productData.plans || {};
        productData.plans[planKey] = sanitizePlan(plan);

        productData.updated_at = admin.firestore.FieldValue.serverTimestamp();
        productData._synced_via = 'admin_api';

        await docRef.set(productData, { merge: true });

        logs.info(`Admin created plan: ${plan.id} and synced to product: ${productId}`);
        return productData;
    } catch (err: any) {
        logs.error(err);
        throw new HttpsError('internal', 'Failed to create plan.', err.message);
    }
});

// ---------- Admin: Sync All Plans ----------
export const syncPlans = onCall(async (request) => {
    // 1. Verify Admin Auth
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
        const count = 100; // max pagination count
        let hasMore = true;

        while (hasMore) {
            const plans = await getRazorpay().plans.all({ skip, count });

            if (plans.items.length === 0) {
                hasMore = false;
                break;
            }

            for (const plan of plans.items) {
                const productId = generateProductId(plan);
                const planKey = generatePlanKey(plan);
                const docRef = db.collection(config.productsCollectionPath).doc(productId);

                const productSnap = await docRef.get();
                const productData = productSnap.data() || {
                    id: productId,
                    name: plan.item?.name || 'Razorpay Product',
                    description: plan.item?.description || '',
                    active: true,
                    allowedPlans: {},
                    created_at: admin.firestore.FieldValue.serverTimestamp(),
                };

                productData.allowedPlans = productData.allowedPlans || {};
                productData.allowedPlans[planKey] = plan.id;

                productData.plans = productData.plans || {};
                productData.plans[planKey] = sanitizePlan(plan);

                productData.updated_at = admin.firestore.FieldValue.serverTimestamp();
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
