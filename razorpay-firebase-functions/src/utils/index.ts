import { FieldValue } from 'firebase-admin/firestore';
import { Plans } from 'razorpay/dist/types/plans';
import { Items } from 'razorpay/dist/types/items';
import { SanitizedPlan } from '../types';

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
