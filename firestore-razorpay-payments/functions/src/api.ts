import { onRequest } from 'firebase-functions/v2/https';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
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
    "payment.authorized",
    "payment.failed",
    "payment.captured",
    "payment.dispute.created",
    "order.paid",
    "order.notification.delivered",
    "order.notification.failed",
    "subscription.authenticated",
    "subscription.paused",
    "subscription.resumed",
    "subscription.activated",
    "subscription.pending",
    "subscription.halted",
    "subscription.charged",
    "subscription.cancelled",
    "subscription.completed",
    "subscription.updated",
    "payment.dispute.won",
    "payment.dispute.lost",
    "payment.dispute.closed",
    "payment.dispute.under_review",
    "payment.dispute.action_required",
    "payment.downtime.started",
    "payment.downtime.updated",
    "payment.downtime.resolved"
]);

// Lazy-init Razorpay: secrets aren't available at module load time
let razorpay: InstanceType<typeof Razorpay>;
export function getRazorpay() {
    if (!razorpay) {
        razorpay = new Razorpay({
            key_id: config.razorpayKeyId,
            key_secret: config.razorpayKeySecret,
        });

        // Allow overriding the API base URL (for emulator/integration testing)
        if (process.env.RAZORPAY_API_URL) {
            console.log("[api.ts] Initializing Razorpay client. RAZORPAY_API_URL:", process.env.RAZORPAY_API_URL);
            (razorpay as any).api.rq.defaults.baseURL = process.env.RAZORPAY_API_URL;
        }
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

    const eventId = (req.headers['x-razorpay-event-id'] as string) || 
                    event.id || 
                    `evt_${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
    const db = admin.firestore();

    const webhookEventRef = db.collection('webhook_events').doc(eventId);
    try {
        const expireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
        await webhookEventRef.create({
            event: event.event,
            status: 'processing',
            created_at: FieldValue.serverTimestamp(),
            updated_at: FieldValue.serverTimestamp(),
            expireAt,
        });
    } catch (e: any) {
        if (e.code === 6) { // ALREADY_EXISTS in gRPC / Firestore
            // Document exists — check if it's a failed retry candidate
            const canRetry = await db.runTransaction(async (tx) => {
                const doc = await tx.get(webhookEventRef);
                if (!doc.exists) return true; // Deleted between create and here (extremely unlikely)
                const data = doc.data();
                
                // Implement a timeout on the processing state lock (2 minutes)
                const updatedAt = data?.updated_at;
                const isStuck = data?.status === 'processing' &&
                                updatedAt &&
                                (typeof updatedAt.toMillis === 'function') &&
                                (Date.now() - updatedAt.toMillis() > 2 * 60 * 1000); // 2 mins

                if (data?.status === 'failed' || isStuck) {
                    // Acquire the retry lock
                    tx.update(webhookEventRef, {
                        status: 'processing',
                        updated_at: FieldValue.serverTimestamp(),
                    });
                    return true;
                }
                return false; // 'processing' or 'completed' — do not re-enter
            });

            if (!canRetry) {
                logs.info(`Webhook event ${eventId} already processed or in-flight. Skipping.`);
                res.status(200).send('Already Processed');
                return;
            }
        } else {
            logs.error(e);
            res.status(500).send('Webhook processing failed internally');
            return;
        }
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

        // Mark idempotency document as completed
        await webhookEventRef.update({
            status: 'completed',
            completed_at: FieldValue.serverTimestamp(),
        }).catch((err) => {
            logs.error(`Failed to update webhook event status to completed (ID: ${eventId})`, err);
        });

        res.status(200).send('Webhook Processed');
    } catch (err: any) {
        logs.error(`Webhook processing failed for event: ${event.event} (ID: ${eventId})`, err);

        // Return 500 for transient/retryable errors to allow Razorpay webhook retries
        const isRetryable = err.code === 'DEADLINE_EXCEEDED' || err.code === 'UNAVAILABLE' || err.message?.includes('timeout') || err.message?.includes('network');

        if (isRetryable) {
            // This allows the next retry to acquire the lock via transaction, while
            // preventing concurrent duplicates from both acquiring the lock simultaneously.
            await webhookEventRef.update({ status: 'failed', updated_at: FieldValue.serverTimestamp() }).catch((err) => {
                logs.error(`Failed to update webhook event status to failed (ID: ${eventId})`, err);
            });
            res.status(500).send('Webhook processing failed internally - retryable');
        } else {
            // Return 200 so Razorpay doesn't retry forever on permanent logic errors.
            // Mark as completed to prevent re-processing of permanently failed events.
            logs.error(`PERMANENT WEBHOOK FAILURE — event ${event.event} (ID: ${eventId}) will NOT be retried. Manual investigation required.`);
            await webhookEventRef.update({ status: 'completed', completed_at: FieldValue.serverTimestamp() }).catch((err) => {
                logs.error(`Failed to update webhook event status to completed on permanent failure (ID: ${eventId})`, err);
            });
            res.status(200).send('Webhook processing failed internally');
        }
    }
};

export const razorpayWebhookHandler = onRequest({ secrets: [razorpayKeySecret, razorpayWebhookSecret] }, webhookHandlerFunc);
