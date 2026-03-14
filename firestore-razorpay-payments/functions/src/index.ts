import { createOrder } from './triggers/createOrder';
import { createSubscription } from './triggers/createSubscription';
import { onUserDeleted } from './triggers/onUserDeleted';
import { logs } from './logs';

import app from './api';

// Initialize logging
logs.init();

// Export triggers
export { createOrder, createSubscription, onUserDeleted };

import * as functions from 'firebase-functions';

// Export the webhook handler and API
export const razorpayWebhookHandler = functions.https.onRequest((req, res) => {
    app(req, res);
});
