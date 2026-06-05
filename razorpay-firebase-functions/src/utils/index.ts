import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { Plans } from 'razorpay/dist/types/plans';
import { Items } from 'razorpay/dist/types/items';
import { RazorpaySyncConfig } from '../types';

/**
 * Helper to sanitize Razorpay plan data for Firestore storage.
 */
export const sanitizePlan = (plan: Plans.RazorPayPlans) => {
    const sanitizedPlan: Record<string, unknown> = {
        id: plan.id,
        entity: plan.entity,
        interval: plan.interval,
        period: plan.period,
        item: plan.item,
        notes: plan.notes || {},
        active: true, // Plans don't return an active boolean at the top level
        created_at: plan.created_at,
        updated_at: FieldValue.serverTimestamp(),
        _synced_via: 'admin_api'
    };

    if (plan.item && (plan.item as Items.RazorpayItem).active !== undefined) {
        sanitizedPlan.active = (plan.item as Items.RazorpayItem).active;
    }

    return sanitizedPlan;
};

export const generateProductId = (plan: Plans.RazorPayPlans) => {
    if (plan.notes && plan.notes.productId) {
        return String(plan.notes.productId);
    }
    if (plan.item && plan.item.name) {
        return plan.item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-+)+/g, '');
    }
    return `prod_${plan.id}`;
};

export const generatePlanKey = (plan: Plans.RazorPayPlans) => {
    if (plan.interval > 1) {
        return `${plan.interval}_${plan.period}`;
    }
    return plan.period;
};

/**
 * Syncs a Razorpay plan to a Firestore product document.
 * Creates or updates the product document with the plan's details.
 * Shared between buildCreatePlan and buildSyncPlans.
 */
export const syncPlanToProduct = async (
    plan: Plans.RazorPayPlans,
    db: admin.firestore.Firestore,
    config: RazorpaySyncConfig
): Promise<FirebaseFirestore.DocumentData> => {
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
    return productData;
};
