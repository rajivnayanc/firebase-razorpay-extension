import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { Plans } from 'razorpay/dist/types/plans';
import { Items } from 'razorpay/dist/types/items';
import { RazorpaySyncConfig, SanitizedPlan, ProductDoc } from '../types';
import { TypedFirestore } from './typedFirestore';

/**
 * Helper to sanitize Razorpay plan data for Firestore storage.
 */
export const sanitizePlan = (plan: Plans.RazorPayPlans): SanitizedPlan => {
    const sanitizedPlan: SanitizedPlan = {
        id: plan.id,
        entity: plan.entity,
        interval: plan.interval,
        period: plan.period,
        item: plan.item ? (plan.item as Items.RazorpayItem) : null,
        notes: plan.notes || {},
        active: true, // Plans don't return an active boolean at the top level
        created_at: plan.created_at,
        updated_at: FieldValue.serverTimestamp(),
        _synced_via: 'admin_api'
    };

    if (plan.item && (plan.item as Items.RazorpayItem).active !== undefined) {
        sanitizedPlan.active = !!(plan.item as Items.RazorpayItem).active;
    }

    return sanitizedPlan;
};

export const generateProductId = (plan: Plans.RazorPayPlans): string => {
    if (plan.notes && plan.notes.productId) {
        return String(plan.notes.productId);
    }
    if (plan.item && plan.item.name) {
        return plan.item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-+)+/g, '');
    }
    return `prod_${plan.id}`;
};

export const generatePlanKey = (plan: Plans.RazorPayPlans): string => {
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
): Promise<ProductDoc> => {
    const productId = generateProductId(plan);
    const typedFs = new TypedFirestore(db, config);
    const docRef = typedFs.getProductDoc(productId);

    const productSnap = await docRef.get();
    const productData: ProductDoc = productSnap.data() || {
        id: productId,
        name: plan.item?.name || 'Razorpay Product',
        description: plan.item?.description || '',
        active: true,
        created_at: FieldValue.serverTimestamp(),
    };

    productData.planId = plan.id;
    productData.type = 'subscription';
    productData.updated_at = FieldValue.serverTimestamp();
    productData._synced_via = 'admin_api';

    if (plan.notes && Object.keys(plan.notes).length > 0) {
        const metadata: Record<string, string> = {};
        for (const [key, value] of Object.entries(plan.notes)) {
            metadata[key] = String(value);
        }
        productData.metadata = metadata;
    }

    await docRef.set(productData, { merge: true });

    // Save plan to root-level plans collection
    const planRef = typedFs.getPlanDoc(plan.id);
    const planData = sanitizePlan(plan);
    await planRef.set(planData, { merge: true });

    return productData;
};
