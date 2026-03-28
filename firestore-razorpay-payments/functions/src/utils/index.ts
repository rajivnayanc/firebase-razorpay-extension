import * as admin from 'firebase-admin';

/**
 * Helper to sanitize Razorpay plan data for Firestore storage.
 */
export const sanitizePlan = (plan: any) => {
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

export const generateProductId = (plan: any) => {
    if (plan.notes && plan.notes.productId) {
        return plan.notes.productId;
    }
    if (plan.item && plan.item.name) {
        return plan.item.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-+)+/g, '');
    }
    return `prod_${plan.id}`;
};

export const generatePlanKey = (plan: any) => {
    if (plan.interval > 1) {
        return `${plan.interval}_${plan.period}`;
    }
    return plan.period;
};

