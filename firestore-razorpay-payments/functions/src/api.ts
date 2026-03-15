import * as functions from 'firebase-functions/v1';
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
    try {
        rawBody = typeof req.rawBody === 'string'
                ? req.rawBody
                : Buffer.isBuffer(req.rawBody)
                    ? req.rawBody.toString('utf8')
                    : JSON.stringify(req.body);
    } catch (e) {
        logs.error(new Error(`Failed to parse raw body: ${e}`));
        res.status(400).send('Invalid Body');
        return;
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
        logs.invalidSignature();
        res.status(400).json({
            error: 'Invalid Signature',
            debug: {
                receivedSignature: signature,
                expectedSecretStringMatch: config.razorpayWebhookSecret === 'whsec_test_integration_secret',
                secretLength: config.razorpayWebhookSecret?.length,
                rawBodyLength: rawBody?.length
            }
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
        logs.error(err);
        // Return 200 so Razorpay doesn't retry forever on code errors
        res.status(200).send('Webhook processing failed internally');
    }
};

export const razorpayWebhookHandler = functions.https.onRequest(webhookHandlerFunc);
