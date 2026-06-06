import { onCall, HttpsError, CallableRequest } from 'firebase-functions/v2/https';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import Razorpay from 'razorpay';
import { logs } from './logs';
import { RazorpaySyncConfig, ProductDoc, CreateProductRequest } from './types';
import { syncPlanToProduct, generateProductId, sanitizePlan } from './utils';
import { TypedFirestore } from './utils/typedFirestore';
import { Plans } from 'razorpay/dist/types/plans';

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
            const typedFs = new TypedFirestore(db, config);

            logs.info('Starting administrative plan synchronization from Razorpay...');

            let skip = 0;
            const count = 100;
            let hasMore = true;
            const allPlans: Plans.RazorPayPlans[] = [];
            const MAX_PLANS = 10000;

            while (hasMore && allPlans.length < MAX_PLANS) {
                logs.info(`Fetching plans from Razorpay (skip: ${skip}, limit: ${count})...`);
                const plans = await rzp.plans.all({ skip, count });
                if (!plans.items || plans.items.length === 0) {
                    break;
                }
                allPlans.push(...plans.items);
                skip += count;
                if (plans.items.length < count) {
                    hasMore = false;
                }
            }

            logs.info(`Fetched ${allPlans.length} plans. Grouping by product ID in memory...`);

            // Group plans by productId in memory
            const productPlansMap = new Map<string, Plans.RazorPayPlans[]>();
            for (const plan of allPlans) {
                const productId = generateProductId(plan);
                if (!productPlansMap.has(productId)) {
                    productPlansMap.set(productId, []);
                }
                productPlansMap.get(productId)!.push(plan);
            }

            logs.info(`Identified ${productPlansMap.size} distinct products. Reading existing products collection...`);

            // Read all existing products to avoid per-document lookups
            const productsCollection = typedFs.getProductsCollection();
            const existingProductsSnap = await productsCollection.get();
            const existingProducts = new Map<string, ProductDoc>();
            for (const doc of existingProductsSnap.docs) {
                existingProducts.set(doc.id, doc.data());
            }

            logs.info('Writing synchronized product catalogs to Firestore via BulkWriter...');

            const bulkWriter = db.bulkWriter();
            bulkWriter.onWriteError((error) => {
                logs.error(new Error(`BulkWriter error: ${error.message}`));
                return false; // Do not retry
            });

            for (const [productId, plans] of productPlansMap.entries()) {
                const productDocRef = typedFs.getProductDoc(productId);
                const existingProduct = existingProducts.get(productId);

                const productData: ProductDoc = existingProduct || {
                    id: productId,
                    name: plans[0].item?.name || 'Razorpay Product',
                    description: plans[0].item?.description || '',
                    active: true,
                    created_at: FieldValue.serverTimestamp(),
                };

                if (plans.length > 0) {
                    productData.planId = plans[0].id;
                }

                productData.type = 'subscription';
                productData.updated_at = FieldValue.serverTimestamp();
                productData._synced_via = 'admin_api';

                bulkWriter.set(productDocRef, productData, { merge: true });

                // Write each plan to root-level plans collection
                for (const plan of plans) {
                    const planDocRef = typedFs.getPlanDoc(plan.id);
                    const planData = sanitizePlan(plan);
                    bulkWriter.set(planDocRef, planData, { merge: true });
                }
            }

            await bulkWriter.close();

            logs.info(`Admin synced ${allPlans.length} plans successfully across ${productPlansMap.size} products.`);
            return { status: 'SUCCESS', count: allPlans.length, productsCount: productPlansMap.size };
        } catch (err: any) {
            logs.error(err);
            throw new HttpsError('internal', 'Sync failed.', err.message);
        }
    });
};

export const buildCreateProduct = (config: RazorpaySyncConfig) => {
    return onCall(async (request: CallableRequest<CreateProductRequest>) => {
        if (!request.auth || request.auth.token.admin !== true) {
            throw new HttpsError(
                'permission-denied',
                'Must be an administrative user to create products.'
            );
        }

        const { id, name, description, type, amount, currency, planId } = request.data;
        if (!id || !name || !type) {
            throw new HttpsError(
                'invalid-argument',
                'Missing required fields: id, name, type.'
            );
        }

        if (type !== 'one-time' && type !== 'subscription') {
            throw new HttpsError(
                'invalid-argument',
                'Type must be "one-time" or "subscription".'
            );
        }

        try {
            const db = admin.firestore();
            const typedFs = new TypedFirestore(db, config);
            const productRef = typedFs.getProductDoc(id);

            const productSnap = await productRef.get();
            const existingProduct = productSnap.data();

            const productData: ProductDoc = existingProduct || {
                id,
                name,
                description: description || '',
                active: true,
                created_at: FieldValue.serverTimestamp(),
            };

            productData.name = name;
            productData.description = description || productData.description || '';
            productData.type = type;
            productData.updated_at = FieldValue.serverTimestamp();
            productData._synced_via = 'admin_sdk_api';

            if (type === 'one-time') {
                if (amount === undefined || amount <= 0 || !currency) {
                    throw new HttpsError(
                        'invalid-argument',
                        'One-time products require a valid positive amount and currency.'
                    );
                }
                productData.amount = amount;
                productData.currency = currency;
                // Remove planId if changing to one-time
                delete productData.planId;
            } else {
                if (planId) {
                    productData.planId = planId;
                }
                // Remove one-time fields if changing to subscription
                delete productData.amount;
                delete productData.currency;
            }

            await productRef.set(productData, { merge: true });
            return productData;
        } catch (err: any) {
            if (err instanceof HttpsError) throw err;
            throw new HttpsError('internal', 'Failed to create product.', err.message);
        }
    });
};
