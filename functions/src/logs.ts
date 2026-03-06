import { logger } from 'firebase-functions';

export const logs = {
    obfuscateKey: (key: string) => {
        if (!key) return '';
        return `...${key.substring(key.length - 4)}`;
    },

    init: () => {
        logger.info('Initializing extension with configuration');
    },

    startWebhook: (eventType: string) => {
        logger.info(`Started processing Razorpay webhook for event: ${eventType}`);
    },

    webhookProcessed: (eventType: string, id: string) => {
        logger.info(`Successfully processed webhook event ${eventType} for entity ${id}`);
    },

    invalidSignature: () => {
        logger.error('Webhook failed signature verification');
    },

    orderCreated: (orderId: string, docPath: string) => {
        logger.info(`Successfully created Razorpay order ${orderId} for ${docPath}`);
    },

    subscriptionCreated: (subId: string, docPath: string) => {
        logger.info(`Successfully created Razorpay subscription ${subId} for ${docPath}`);
    },

    error: (err: Error) => {
        logger.error('Error occurred:', err);
    }
};
