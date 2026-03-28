import { onRequest } from 'firebase-functions/v2/https';
import Razorpay from 'razorpay';
import { verifyWebhookSignature } from './security';
import config, { getEventChannel } from './config';
import { logs } from './logs';

import { handleSubscriptionEvent } from './handlers/subscriptions';
import { handlePaymentEvent } from './handlers/payments';

// eventChannel is retrieved inside the handler to support lazy initialization and testability

// Lazy-init Razorpay: secrets aren't available at module load time
let razorpay: InstanceType<typeof Razorpay>;
export function getRazorpay() {
    if (!razorpay) {
        razorpay = new Razorpay({
            key_id: config.razorpayKeyId,
            key_secret: config.razorpayKeySecret,
        });
    }
    return razorpay;
}

// ---------- Webhooks (Raw HTTP Handler) ----------
export const webhookHandlerFunc = async (req: any, res: any) => {
    // Only accept POST requests
    if (req.method !== 'POST') {
        res.status(405).send('Method Not Allowed');
        return;
    }

    const signature = req.headers['x-razorpay-signature'] as string;

    // Cloud Functions provides rawBody as a Buffer on req
    let rawBody = '';
    if (typeof req.rawBody === 'string') {
        rawBody = req.rawBody;
    } else if (Buffer.isBuffer(req.rawBody)) {
        rawBody = req.rawBody.toString('utf8');
    } else {
        logs.error(new Error('req.rawBody is missing or not a Buffer/String. Ensure you are not parsing the body before this handler.'));
        res.status(400).send('Invalid Body');
        return;
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
        logs.invalidSignature();
        res.status(401).json({
            error: 'Unauthorized',
        });
        return;
    }

    const event = req.body;
    logs.startWebhook(event.event);

    try {
        // Route the event to the correct handler
        if (event.event.startsWith('subscription.')) {
            await handleSubscriptionEvent(event);
        } else if (event.event.startsWith('payment.') || event.event.startsWith('order.')) {
            await handlePaymentEvent(event);
        }

        // Publish to Eventarc channel if configured
        const eventChannel = getEventChannel();
        if (eventChannel) {
            await eventChannel.publish({
                type: `com.razorpay.v1.${event.event}`,
                data: event.payload,
            });
        }

        res.status(200).send('Webhook Processed');
    } catch (err: any) {
        logs.error(`Webhook processing failed for event: ${event.event} (ID: ${event.id || 'unknown'})`, err);
        
        // Return 500 for transient/retryable errors to allow Razorpay webhook retries
        const isRetryable = err.code === 'DEADLINE_EXCEEDED' || err.code === 'UNAVAILABLE' || err.message?.includes('timeout') || err.message?.includes('network');
        
        if (isRetryable) {
            res.status(500).send('Webhook processing failed internally - retryable');
        } else {
            // Return 200 so Razorpay doesn't retry forever on permanent logic errors.
            // Set up Cloud Monitoring alerts for 'PERMANENT WEBHOOK FAILURE' log entries.
            logs.error(`PERMANENT WEBHOOK FAILURE — event ${event.event} will NOT be retried. Manual investigation required.`);
            res.status(200).send('Webhook processing failed internally');
        }
    }
};

export const razorpayWebhookHandler = onRequest(webhookHandlerFunc);
