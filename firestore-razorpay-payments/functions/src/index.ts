import { createOrder } from './triggers/createOrder';
import { createSubscription } from './triggers/createSubscription';
import { createCustomer } from './triggers/createCustomer';
import { onUserDeleted, onCustomerDataDeleted } from './triggers/onUserDeleted';
import { razorpayWebhookHandler } from './api';
import { createPlan, syncPlans } from './admin';
import { syncClaimsOnSubscriptionChange } from './triggers/syncClaims';

import { logs } from './logs';

// Initialize logging
logs.init();

// Early validation of configuration
import config from './config';
if (!config.razorpayKeyId || !config.razorpayKeySecret) {
    logs.error(new Error("RAZORPAY_KEY_ID or RAZORPAY_KEY_SECRET is missing. Extension will not function correctly."));
} else if (!config.razorpayKeyId.startsWith('rzp_')) {
    logs.error(new Error(`RAZORPAY_KEY_ID seems malformed (expected to start with 'rzp_'). Configuration is likely invalid.`));
}

import { cancelSubscription, updateSubscriptionPlan } from './callables/subscriptions';

// Export all Extension functions
export {
    // Session Triggers
    createOrder,
    createSubscription,

    // Auth and Lifecycle Triggers
    createCustomer,
    onUserDeleted,
    onCustomerDataDeleted,

    // Webhooks
    razorpayWebhookHandler,
    syncClaimsOnSubscriptionChange,

    // Admin Calls
    createPlan,
    syncPlans,

    // Client Callables
    cancelSubscription,
    updateSubscriptionPlan
};
