import Razorpay from 'razorpay';
import { getEventarc, Channel } from 'firebase-admin/eventarc';
import { RazorpayUserConfig, RazorpaySyncConfig } from './types';
import { logs } from './logs';

// Import builders
import { buildCreateOrder } from './triggers/createOrder';
import { buildCreateSubscription } from './triggers/createSubscription';
import { buildCreateCustomer } from './triggers/createCustomer';
import { buildOnCustomerDataDeleted, buildOnUserDeleted } from './triggers/onUserDeleted';
import { buildCancelSubscription, buildUpdateSubscriptionPlan } from './callables/subscriptions';
import { buildCreatePlan, buildSyncPlans } from './admin';
import { buildWebhookHandler } from './api';

export { RazorpayUserConfig, RazorpaySyncConfig } from './types';

export function initializeRazorpay(userConfig: RazorpayUserConfig) {
    // 1. Log initialization
    logs.init();

    // 2. Validate required configs
    if (!userConfig.keyId || !userConfig.keySecret) {
        logs.error(new Error("keyId or keySecret is missing. Razorpay functions will not function correctly."));
    } else if (!userConfig.keyId.startsWith('rzp_')) {
        logs.error(new Error(`keyId seems malformed (expected to start with 'rzp_'). Configuration is likely invalid.`));
    }

    if (!userConfig.webhookSecret) {
        logs.error(new Error('webhookSecret is missing. Webhook signature verification will reject all incoming events.'));
    }

    // 3. Apply defaults
    const config: RazorpaySyncConfig = {
        keyId: userConfig.keyId,
        keySecret: userConfig.keySecret,
        webhookSecret: userConfig.webhookSecret,
        customersCollection: userConfig.customersCollection || 'customers',
        productsCollection: userConfig.productsCollection || 'products',
        syncCustomers: userConfig.syncCustomers ?? true,
        eventarcChannel: userConfig.eventarcChannel,
        allowedEventTypes: userConfig.allowedEventTypes,
    };

    // 4. Initialize Razorpay Client once
    const rzpClient = new Razorpay({
        key_id: config.keyId,
        key_secret: config.keySecret,
    });

    // Allow overriding the API base URL (for emulator/integration testing ONLY)
    if (process.env.RAZORPAY_API_URL) {
        if (process.env.NODE_ENV === 'production') {
            logs.error(new Error('RAZORPAY_API_URL is set in production. This is a security risk (SSRF). Ignoring.'));
        } else {
            logs.info(`Initializing Razorpay client with custom base URL: ${process.env.RAZORPAY_API_URL}`);
            (rzpClient as any).api.rq.defaults.baseURL = process.env.RAZORPAY_API_URL;
        }
    }

    // 5. Initialize Eventarc channel if configured
    let eventChannel: Channel | null = null;
    if (config.eventarcChannel) {
        try {
            eventChannel = getEventarc().channel(config.eventarcChannel, {
                allowedEventTypes: config.allowedEventTypes,
            });
        } catch (e: any) {
            logs.error(`Failed to initialize Eventarc channel: ${e.message || e}`);
        }
    }

    // 6. Build and return grouped functions
    return {
        // Session and Subscription Firestore Triggers
        createOrder: buildCreateOrder(config, rzpClient),
        createSubscription: buildCreateSubscription(config, rzpClient),

        // Auth and lifecycle triggers
        createCustomer: buildCreateCustomer(config, rzpClient),
        onUserDeleted: buildOnUserDeleted(config),
        onCustomerDataDeleted: buildOnCustomerDataDeleted(config, rzpClient),

        // HTTPS Webhook Handler
        webhookHandler: buildWebhookHandler(config, rzpClient, eventChannel),

        // Client Callables
        cancelSubscription: buildCancelSubscription(config, rzpClient),
        updateSubscriptionPlan: buildUpdateSubscriptionPlan(config, rzpClient),

        // Admin callables
        createPlan: buildCreatePlan(config, rzpClient),
        syncPlans: buildSyncPlans(config, rzpClient),
    };
}
