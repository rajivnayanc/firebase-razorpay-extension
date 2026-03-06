import { onRequest } from 'firebase-functions/v2/https';
import { createOrder } from './triggers/createOrder';
import { createSubscription } from './triggers/createSubscription';
import { logs } from './logs';

import app from './api';

// Initialize logging
logs.init();

// Export triggers
export { createOrder, createSubscription };

// Export the webhook handler and API
export const razorpayWebhookHandler = onRequest({ secrets: [] }, app);
