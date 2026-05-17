import { onRequest } from 'firebase-functions/v2/https';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { verifyWebhookSignature } from './security';
import config, { getEventChannel, razorpayKeySecret, razorpayWebhookSecret } from './config';
import { logs } from './logs';

import { handleSubscriptionEvent } from './handlers/subscriptions';
import { handlePaymentEvent } from './handlers/payments';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

export interface WebhookEvent {
    event: string;
    id: string;
    payload: any;
    created_at?: number;
}

const ALLOWED_EVENTS = new Set([
    'subscription.charged',
    'subscription.authenticated',
    'subscription.active',
    'subscription.halted',
    'subscription.paused',
    'subscription.cancelled',
    'subscription.completed',
    'subscription.pending',
    'payment.captured',
    'payment.failed',
    'order.paid',
]);

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

    const event = req.body as WebhookEvent;
    logs.startWebhook(event.event);

    if (!ALLOWED_EVENTS.has(event.event)) {
        res.status(200).send('Event not handled');
        return;
    }

    const db = admin.firestore();

    // Idempotency: Prevent Webhook Replay Attacks
    const webhookEventRef = db.collection('webhook_events').doc(event.id);
    try {
        await webhookEventRef.create({
            event: event.event,
            processed_at: admin.firestore.FieldValue.serverTimestamp(),
        });
    } catch (e: any) {
        if (e.code === 6) { // ALREADY_EXISTS in gRPC / Firestore
            logs.info(`Webhook event ${event.id} already processed. Skipping.`);
            res.status(200).send('Already Processed');
            return;
        }
        logs.error(e);
        res.status(500).send('Webhook processing failed internally');
        return;
    }

    try {
        const rzpClient = getRazorpay();
        
        // Route the event to the correct handler with Dependency Injection
        if (event.event.startsWith('subscription.')) {
            await handleSubscriptionEvent(event, db, rzpClient);
        } else if (event.event.startsWith('payment.') || event.event.startsWith('order.')) {
            await handlePaymentEvent(event, db, rzpClient);
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
            // Remove the idempotency lock so it can be retried
            await webhookEventRef.delete().catch(() => {});
            res.status(500).send('Webhook processing failed internally - retryable');
        } else {
            // Return 200 so Razorpay doesn't retry forever on permanent logic errors.
            logs.error(`PERMANENT WEBHOOK FAILURE — event ${event.event} will NOT be retried. Manual investigation required.`);
            res.status(200).send('Webhook processing failed internally');
        }
    }
};

export const razorpayWebhookHandler = onRequest({ secrets: [razorpayKeySecret, razorpayWebhookSecret] }, webhookHandlerFunc);
