import { createOrder } from './triggers/createOrder';
import { createSubscription } from './triggers/createSubscription';
import { createCustomer } from './triggers/createCustomer';
import { onUserDeleted, onCustomerDataDeleted } from './triggers/onUserDeleted';
import { razorpayWebhookHandler } from './api';
import { createPlan, syncPlans } from './admin';

import { logs } from './logs';

// Initialize logging
logs.init();

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

    // Admin Calls
    createPlan,
    syncPlans
};
