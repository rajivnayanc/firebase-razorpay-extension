import { getEventarc } from 'firebase-admin/eventarc';

export default {
    // Extension parameters
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    razorpayWebhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',

    // Firestore paths
    customersCollectionPath: process.env.CUSTOMERS_COLLECTION || 'customers',
    productsCollectionPath: process.env.PRODUCTS_COLLECTION || 'products',

    // CORS: comma-separated list of allowed origins for authenticated endpoints
    // Leave empty to allow all origins (not recommended for production)
    allowedOrigins: process.env.ALLOWED_ORIGINS || '',

    // Dedup event TTL in days (events older than this are eligible for cleanup)
    dedupTtlDays: parseInt(process.env.DEDUP_TTL_DAYS || '7', 10),
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
