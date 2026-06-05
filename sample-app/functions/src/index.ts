import * as admin from 'firebase-admin';
import { initializeRazorpay } from '@neocleus/razorpay-firebase-functions';

// Initialize firebase-admin SDK
admin.initializeApp();

// Initialize and export Razorpay functions using environmental variables
const rzpFuncs = initializeRazorpay({
    keyId: process.env.RAZORPAY_KEY_ID!,
    keySecret: process.env.RAZORPAY_KEY_SECRET!,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET!,
    customersCollection: process.env.CUSTOMERS_COLLECTION || 'customers',
    productsCollection: process.env.PRODUCTS_COLLECTION || 'products',
    syncCustomers: process.env.SYNC_CUSTOMERS !== 'false',
});

// Re-export functions to be deployed as flat Cloud Functions
export const createOrder = rzpFuncs.createOrder;
export const createSubscription = rzpFuncs.createSubscription;
export const createCustomer = rzpFuncs.createCustomer;
export const onUserDeleted = rzpFuncs.onUserDeleted;
export const onCustomerDataDeleted = rzpFuncs.onCustomerDataDeleted;
export const webhookHandler = rzpFuncs.webhookHandler;
export const cancelSubscription = rzpFuncs.cancelSubscription;
export const updateSubscriptionPlan = rzpFuncs.updateSubscriptionPlan;
export const createPlan = rzpFuncs.createPlan;
export const syncPlans = rzpFuncs.syncPlans;
