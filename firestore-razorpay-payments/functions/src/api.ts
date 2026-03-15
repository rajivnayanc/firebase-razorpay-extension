import { FieldValue } from 'firebase-admin/firestore';
import express, { Response } from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { verifyWebhookSignature } from './security';
import config, { getEventChannel } from './config';
import { logs } from './logs';
import { authenticate, AuthenticatedRequest } from './middleware/authenticate';
import { requireAdmin } from './middleware/requireAdmin';
// const { validatePaymentVerification } = require('razorpay/dist/utils/razorpay-utils');

import { handleSubscriptionEvent } from './handlers/subscriptions';
import { handlePaymentEvent } from './handlers/payments';

const app = express();
const eventChannel = getEventChannel();

// Middleware to parse JSON bodies and keep raw string for signature validation
app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf.toString();
    }
}));
app.use(express.urlencoded({ extended: true }));

// CORS: webhooks accept any origin (Razorpay servers), authenticated routes are restricted
const openCors = cors({ origin: true });
const restrictedCors = cors({
    origin: config.allowedOrigins ? config.allowedOrigins.split(',') : true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
});

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

// ---------- Webhooks (open CORS, no rate limit) ----------
app.post('/webhook', openCors, async (req: any, res: Response) => {
    const signature = req.headers['x-razorpay-signature'] as string;

    // Cloud Functions (emulator & prod) provides rawBody as a Buffer on req.
    // Our Express verify callback also sets it as a string.
    // Handle both cases: Buffer → toString(), string → use as-is.
    let rawBody = '';
    try {
        rawBody =
            typeof req.rawBody === 'string'
                ? req.rawBody
                : Buffer.isBuffer(req.rawBody)
                    ? req.rawBody.toString('utf8')
                    : JSON.stringify(req.body);
    } catch (e) {
        logs.error(new Error(`Failed to parse raw body: ${e}`));
        res.status(400).send('Invalid Body');
        return;
    }

    logs.info(`WEBHOOK DEBUG: received signature: ${signature}`);
    logs.info(`WEBHOOK DEBUG: rawBody type: ${typeof req.rawBody}, fallback type: ${typeof rawBody}`);
    logs.info(`WEBHOOK DEBUG: rawBody content: ${rawBody}`);

    if (!verifyWebhookSignature(rawBody, signature)) {
        logs.invalidSignature();
        // Return debug info in response body so tests can log it
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

        // Publish to Eventarc channel if configured (Stripe extension pattern)
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
});

// ---------- Verify Order (restricted CORS + auth) ----------
app.get('/verify-order/:orderId', restrictedCors, authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { orderId } = req.params;
        const order = await getRazorpay().orders.fetch(orderId);

        if (order.status === 'paid') {
            const notes = order.notes as any;

            // Ownership check: ensure the order belongs to the authenticated user
            if (notes && notes.uid && notes.sessionId) {
                if (notes.uid !== req.user?.uid) {
                    res.status(403).json({ error: 'Forbidden.' });
                    return;
                }

                const db = admin.firestore();
                const docRef = db.collection(config.customersCollectionPath)
                    .doc(notes.uid)
                    .collection('checkout_sessions')
                    .doc(notes.sessionId);

                await docRef.set({
                    ...order,
                    status: 'paid',
                    order_id: order.id,
                    updated_at: FieldValue.serverTimestamp(),
                }, { merge: true });
            }
        }

        // Return minimal order info (don't leak internal notes)
        res.status(200).json({
            id: order.id,
            status: order.status,
            amount: order.amount,
            currency: order.currency,
            created_at: order.created_at,
        });
    } catch (err: any) {
        logs.error(err);
        res.status(500).json({ error: 'An internal error occurred.' });
    }
});

// ---------- Sync Entities directly via API polling (restricted CORS + auth) ----------
// Used by the client to sync status directly after successful payment flow
app.post('/verify-payment', restrictedCors, authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_subscription_id, sessionId } = req.body;

        if (!req.user?.uid) {
            res.status(401).json({ error: 'Unauthorized' });
            return;
        }

        // If it's an order payment, sync it to the session proactively by fetching absolute truth
        if (razorpay_order_id && sessionId) {
            const order = await getRazorpay().orders.fetch(razorpay_order_id);
            const notes = order.notes as any;

            if (notes && notes.uid === req.user.uid && notes.sessionId === sessionId) {
                const db = admin.firestore();
                const docRef = db.collection(config.customersCollectionPath)
                    .doc(req.user.uid)
                    .collection('checkout_sessions')
                    .doc(sessionId);

                await docRef.set({
                    ...order,
                    status: order.status === 'paid' ? 'paid' : 'processing',
                    order_id: razorpay_order_id,
                    payment_id: razorpay_payment_id || null, // Optional, depending on if multiple payments attach to an order
                    updated_at: FieldValue.serverTimestamp(),
                }, { merge: true });

                res.status(200).json({ status: 'PASSED' });
                return;
            } else {
                res.status(400).json({ status: 'FAILED', message: 'Order mismatch or missing parameters.' });
                return;
            }
        } else if (razorpay_subscription_id && sessionId) {
            // Subscription checkout sessions handling (if any, matching the sessionId concept)
            const subscription = await getRazorpay().subscriptions.fetch(razorpay_subscription_id);
            const notes = subscription.notes as any;

            if (notes && notes.uid === req.user.uid) {
                const db = admin.firestore();
                const subId = notes.subscriptionId || razorpay_subscription_id; // Match handlers logic

                const docRef = db.collection(config.customersCollectionPath)
                    .doc(req.user.uid)
                    .collection('subscriptions')
                    .doc(subId);

                await docRef.set({
                    ...subscription,
                    status: subscription.status,
                    updated_at: FieldValue.serverTimestamp(),
                }, { merge: true });

                res.status(200).json({ status: 'PASSED' });
                return;
            } else {
                res.status(400).json({ status: 'FAILED', message: 'Subscription mismatch or missing parameters.' });
                return;
            }
        }

        res.status(400).json({ status: 'FAILED', message: 'Missing parameters.' });
    } catch (err: any) {
        logs.error(err);
        // Sanitized error: don't leak internal details
        res.status(500).json({ status: 'FAILED', message: 'Sync failed. Please try again.' });
    }
});

// ---------- Admin: Create Plan (restricted CORS + auth + admin) ----------
app.post('/admin/plans', restrictedCors, authenticate, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { period, interval, item, notes } = req.body;

        if (!period || !interval || !item || !item.name || !item.amount) {
            res.status(400).json({ error: 'Missing required fields: period, interval, item details.' });
            return;
        }

        // Create plan in Razorpay
        const plan = await getRazorpay().plans.create({
            period,
            interval,
            item,
            notes
        });

        // Store sanitized plan in Firestore
        const db = admin.firestore();
        const docRef = db.collection(config.productsCollectionPath).doc(plan.id);

        // Strip out unsafe internal fields before saving
        const sanitizedPlan: any = {
            id: plan.id,
            entity: plan.entity,
            interval: plan.interval,
            period: plan.period,
            item: plan.item,
            notes: plan.notes || {},
            active: true, // Plans don't return an active boolean at the top level, but item does
            created_at: plan.created_at,
            updated_at: FieldValue.serverTimestamp(),
            _synced_via: 'admin_api'
        };

        if (plan.item && (plan.item as any).active !== undefined) {
            sanitizedPlan.active = (plan.item as any).active;
        }

        await docRef.set(sanitizedPlan, { merge: true });

        logs.info(`Admin created plan: ${plan.id}`);
        res.status(201).json(sanitizedPlan);
    } catch (err: any) {
        logs.error(err);
        res.status(500).json({ error: 'Failed to create plan.', details: err.message });
    }
});

// ---------- Admin: Sync All Plans (restricted CORS + auth + admin) ----------
app.post('/admin/plans/sync', restrictedCors, authenticate, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const db = admin.firestore();
        let syncedCount = 0;
        let skip = 0;
        const count = 100; // max pagination count
        let hasMore = true;

        while (hasMore) {
            const plans = await getRazorpay().plans.all({ skip, count });

            if (plans.items.length === 0) {
                hasMore = false;
                break;
            }

            // Using normal sets instead of batching to keep it simple and deal with large sizes cleanly if needed
            for (const plan of plans.items) {
                const docRef = db.collection(config.productsCollectionPath).doc(plan.id);

                const sanitizedPlan: any = {
                    id: plan.id,
                    entity: plan.entity,
                    interval: plan.interval,
                    period: plan.period,
                    item: plan.item,
                    notes: plan.notes || {},
                    active: true,
                    created_at: plan.created_at,
                    updated_at: FieldValue.serverTimestamp(),
                    _synced_via: 'admin_api'
                };

                if (plan.item && (plan.item as any).active !== undefined) {
                    sanitizedPlan.active = (plan.item as any).active;
                }

                await docRef.set(sanitizedPlan, { merge: true });
                syncedCount++;
            }

            skip += count;
            // Stop if we got fewer than requested
            if (plans.items.length < count) {
                hasMore = false;
            }
        }

        logs.info(`Admin synced ${syncedCount} plans successfully.`);
        res.status(200).json({ status: 'SUCCESS', count: syncedCount });
    } catch (err: any) {
        logs.error(err);
        res.status(500).json({ status: 'FAILED', message: 'Sync failed.', details: err.message });
    }
});

// ---------- Public: Get Available Plans (restricted CORS + auth) ----------
app.get('/plans', restrictedCors, authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const db = admin.firestore();
        const snapshot = await db.collection(config.productsCollectionPath)
            .where('entity', '==', 'plan')
            .where('active', '==', true)
            .get();

        const plans = snapshot.docs.map(doc => {
            const data = doc.data();
            return {
                id: data.id,
                name: data.item?.name,
                description: data.item?.description,
                amount: data.item?.amount,
                currency: data.item?.currency,
                period: data.period,
                interval: data.interval,
                firebaseRole: data.notes?.firebaseRole || data.razorpay_notes_firebaseRole || null
            };
        });

        res.status(200).json({ items: plans });
    } catch (err: any) {
        logs.error(err);
        res.status(500).json({ error: 'Failed to fetch plans.' });
    }
});
// Endpoint removed and migrated to sample-app

export default app;
