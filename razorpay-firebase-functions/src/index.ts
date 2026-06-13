import Razorpay from 'razorpay';
import { RazorpayUserConfig, RazorpaySyncConfig } from './types';
import { logs } from './logs';

// Import builders
import { buildCreateOrder } from './triggers/createOrder';
import { buildCreateSubscription } from './triggers/createSubscription';
import { buildCreateCustomer } from './triggers/createCustomer';
import { buildOnCustomerDataDeleted, buildOnUserDeleted } from './triggers/onUserDeleted';
import { buildCancelSubscription, buildUpdateSubscriptionPlan } from './callables/subscriptions';
import { buildCreatePlan, buildSyncPlans, buildCreateProduct } from './admin';
import { buildWebhookHandler } from './api';

export { RazorpayUserConfig, RazorpaySyncConfig, OnCheckoutSessionUpdate, OnSubscriptionUpdate } from './types';

export function initializeRazorpay(userConfig: RazorpayUserConfig) {
    // 1. Log initialization
    logs.init();

    // 2. Apply defaults (deferred validation of secrets to runtime)
    const config: RazorpaySyncConfig = {
        keyId: userConfig.keyId,
        keySecret: userConfig.keySecret,
        webhookSecret: userConfig.webhookSecret,
        customersCollection: userConfig.customersCollection || 'customers',
        productsCollection: userConfig.productsCollection || 'products',
        plansCollection: userConfig.plansCollection || 'plans',
        syncCustomers: userConfig.syncCustomers ?? true,
        onCheckoutSessionUpdate: userConfig.onCheckoutSessionUpdate,
        onSubscriptionUpdate: userConfig.onSubscriptionUpdate,
        webhookOptions: userConfig.webhookOptions,
    };

    // 3. Lazy initialize Razorpay Client
    let rzpClientInstance: Razorpay | null = null;

    // Wrap in Proxy to defer validation and initialization to runtime property access
    const rzpClient = new Proxy({} as Razorpay, {
        get(target, prop, receiver) {
            if (!rzpClientInstance) {
                // Validate required configs at runtime on first API request or access
                if (!config.keyId || !config.keySecret) {
                    throw new Error("keyId or keySecret is missing. Razorpay functions cannot be initialized.");
                } else if (!config.keyId.startsWith('rzp_')) {
                    throw new Error(`keyId seems malformed (expected to start with 'rzp_'). Configuration is invalid.`);
                }

                if (!config.webhookSecret) {
                    throw new Error('webhookSecret is missing. Razorpay functions cannot be initialized.');
                }

                rzpClientInstance = new Razorpay({
                    key_id: config.keyId,
                    key_secret: config.keySecret,
                });
            }
            const value = Reflect.get(rzpClientInstance, prop, receiver);
            return typeof value === 'function' ? value.bind(rzpClientInstance) : value;
        }
    });

    // 5. Build and return grouped functions
    return {
        // Session and Subscription Firestore Triggers
        createOrder: buildCreateOrder(config, rzpClient),
        createSubscription: buildCreateSubscription(config, rzpClient),

        // Auth and lifecycle triggers
        createCustomer: buildCreateCustomer(config, rzpClient),
        onUserDeleted: buildOnUserDeleted(config),
        onCustomerDataDeleted: buildOnCustomerDataDeleted(config, rzpClient),

        // HTTPS Webhook Handler
        webhookHandler: buildWebhookHandler(config, rzpClient),

        // Client Callables
        cancelSubscription: buildCancelSubscription(config, rzpClient),
        updateSubscriptionPlan: buildUpdateSubscriptionPlan(config, rzpClient),

        // Admin callables
        createPlan: buildCreatePlan(config, rzpClient),
        syncPlans: buildSyncPlans(config, rzpClient),
        createProduct: buildCreateProduct(config),
    };
}
