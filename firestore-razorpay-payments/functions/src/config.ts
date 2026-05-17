import { getEventarc } from 'firebase-admin/eventarc';
import { defineSecret } from 'firebase-functions/params';
import * as admin from 'firebase-admin';

export const razorpayKeySecret = defineSecret('RAZORPAY_KEY_SECRET');
export const razorpayWebhookSecret = defineSecret('RAZORPAY_WEBHOOK_SECRET');

// Initialize Firebase Admin globally and configure Firestore settings
if (!admin.apps || !admin.apps.length) {
    if (typeof admin.initializeApp === 'function') {
        admin.initializeApp();
    }
}
try {
    if (typeof admin.firestore === 'function') {
        admin.firestore().settings({ ignoreUndefinedProperties: true });
    }
} catch (e) {
    // Ignore already initialized settings error
}

export default {
    // Extension parameters
    get razorpayKeyId() { return process.env.RAZORPAY_KEY_ID || ''; },
    get razorpayKeySecret() { return razorpayKeySecret.value() || process.env.RAZORPAY_KEY_SECRET || ''; },
    get razorpayWebhookSecret() { return razorpayWebhookSecret.value() || process.env.RAZORPAY_WEBHOOK_SECRET || ''; },

    // Firestore paths
    get customersCollectionPath() { return process.env.CUSTOMERS_COLLECTION || 'customers'; },
    get productsCollectionPath() { return process.env.PRODUCTS_COLLECTION || 'products'; },

    // CORS: comma-separated list of allowed origins for authenticated endpoints
    // Leave empty to allow all origins (not recommended for production)
    get allowedOrigins() { return process.env.ALLOWED_ORIGINS || ''; },

    // Automated Sync Toggles
    get syncCustomers() { return process.env.SYNC_CUSTOMERS !== 'false'; },
    get syncCustomClaims() { return process.env.SYNC_CUSTOM_CLAIMS !== 'false'; },
};

/**
 * Get the Eventarc channel for publishing custom events.
 * Returns null if Eventarc is not configured.
 * Follows the Stripe extension pattern for extensibility.
 */
export const getEventChannel = () => {
    return (
        process.env.EVENTARC_CHANNEL &&
        getEventarc().channel(process.env.EVENTARC_CHANNEL, {
            allowedEventTypes: process.env.EXT_SELECTED_EVENTS,
        })
    );
};
