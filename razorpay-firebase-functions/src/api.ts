import { onRequest } from 'firebase-functions/v2/https';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { FieldValue } from 'firebase-admin/firestore';
import { Channel } from 'firebase-admin/eventarc';
import { verifyWebhookSignature } from './security';
import { logs } from './logs';
import { WebhookEvent, RazorpaySyncConfig } from './types';
import { handleSubscriptionEvent } from './handlers/subscriptions';
import { handlePaymentEvent } from './handlers/payments';
import { isTransientError } from './utils/retry';
import { TypedFirestore } from './utils/typedFirestore';

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

export const buildWebhookHandler = (
    config: RazorpaySyncConfig,
    rzp: Razorpay,
    eventChannel: Channel | null
) => {
    const webhookHandlerFunc = async (req: any, res: any) => {
        if (req.method !== 'POST') {
            res.status(405).send('Method Not Allowed');
            return;
        }

        const signature = req.headers['x-razorpay-signature'] as string;

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

        if (!verifyWebhookSignature(rawBody, signature, config.webhookSecret)) {
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

        const eventId = event.id ||
            (req.headers['x-razorpay-event-id'] as string) ||
            `evt_${crypto.createHash('sha256').update(rawBody).digest('hex')}`;
        const db = admin.firestore();
        const typedFs = new TypedFirestore(db, config);

        const webhookEventRef = typedFs.getWebhookEventDoc(eventId);
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
            if (e.code === 6 || e.code === 'already-exists') {
                const canRetry = await db.runTransaction(async (tx) => {
                    const doc = await tx.get(webhookEventRef);
                    if (!doc.exists) return true;
                    const data = doc.data();

                    const updatedAt = data?.updated_at;
                    const isTimestamp = updatedAt instanceof admin.firestore.Timestamp;
                    const isStuck = data?.status === 'processing' &&
                        updatedAt &&
                        isTimestamp &&
                        (Date.now() - (updatedAt as admin.firestore.Timestamp).toMillis() > 2 * 60 * 1000); // 2 mins

                    if (data?.status === 'failed' || isStuck) {
                        tx.update(webhookEventRef, {
                            status: 'processing',
                            updated_at: FieldValue.serverTimestamp(),
                        });
                        return true;
                    }
                    return false;
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
            if (event.event.startsWith('subscription.')) {
                await handleSubscriptionEvent(event, db, rzp, config);
            } else if (event.event.startsWith('payment.') || event.event.startsWith('order.')) {
                await handlePaymentEvent(event, db, rzp, config);
            }

            if (eventChannel) {
                await eventChannel.publish({
                    type: `com.razorpay.v1.${event.event}`,
                    data: event.payload,
                });
            }

            await webhookEventRef.update({
                status: 'completed',
                completed_at: FieldValue.serverTimestamp(),
            }).catch((err) => {
                logs.error(`Failed to update webhook event status to completed (ID: ${eventId})`, err);
            });

            res.status(200).send('Webhook Processed');
        } catch (err: any) {
            logs.error(`Webhook processing failed for event: ${event.event} (ID: ${eventId})`, err);

            const isRetryable = isTransientError(err);

            if (isRetryable) {
                await webhookEventRef.update({ status: 'failed', updated_at: FieldValue.serverTimestamp() }).catch((err) => {
                    logs.error(`Failed to update webhook event status to failed (ID: ${eventId})`, err);
                });
                res.status(500).send('Webhook processing failed internally - retryable');
            } else {
                logs.error(`PERMANENT WEBHOOK FAILURE — event ${event.event} (ID: ${eventId}) will NOT be retried. Manual investigation required.`);
                await webhookEventRef.update({ status: 'permanently_failed', completed_at: FieldValue.serverTimestamp() }).catch((err) => {
                    logs.error(`Failed to update webhook event status to permanently_failed (ID: ${eventId})`, err);
                });
                res.status(200).send('Webhook processing failed permanently');
            }
        }
    };

    return onRequest({
        timeoutSeconds: 120,
        memory: '256MiB',
        maxInstances: 10,
        minInstances: 0,
        ...config.webhookOptions,
    }, webhookHandlerFunc);
};
