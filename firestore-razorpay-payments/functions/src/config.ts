import { getEventarc } from 'firebase-admin/eventarc';

export default {
    // Extension parameters
    get razorpayKeyId() { return process.env.RAZORPAY_KEY_ID || ''; },
    get razorpayKeySecret() { return process.env.RAZORPAY_KEY_SECRET || ''; },
    get razorpayWebhookSecret() { return process.env.RAZORPAY_WEBHOOK_SECRET || ''; },

    // Firestore paths
    get customersCollectionPath() { return process.env.CUSTOMERS_COLLECTION || 'customers'; },
    get productsCollectionPath() { return process.env.PRODUCTS_COLLECTION || 'products'; },

    // CORS: comma-separated list of allowed origins for authenticated endpoints
    // Leave empty to allow all origins (not recommended for production)
    get allowedOrigins() { return process.env.ALLOWED_ORIGINS || ''; },
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
