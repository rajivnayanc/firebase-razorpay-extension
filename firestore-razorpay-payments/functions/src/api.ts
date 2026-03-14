import { FieldValue } from 'firebase-admin/firestore';
import express, { Response } from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { verifyWebhookSignature } from './security';
import config, { getEventChannel } from './config';
import { logs } from './logs';
import { authenticate, AuthenticatedRequest } from './middleware/authenticate';
import { isTerminalSessionStatus } from './stateMachine';
const { validatePaymentVerification } = require('razorpay/dist/utils/razorpay-utils');

import { handleProductEvent } from './handlers/products';
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

// ---------- Rate Limiting ----------
// Simple in-memory rate limiter per IP (per Cloud Function instance)
// For production at scale, use Redis or Firestore-based rate limiting
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX = 30; // 30 requests per minute per IP

function rateLimit(req: any, res: Response, next: Function) {
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const now = Date.now();
    const entry = rateLimitMap.get(ip);

    if (!entry || now > entry.resetAt) {
        rateLimitMap.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return next();
    }

    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
        res.status(429).json({ error: 'Too many requests. Please try again later.' });
        return;
    }

    return next();
}

// CORS: webhooks accept any origin (Razorpay servers), authenticated routes are restricted
const openCors = cors({ origin: true });
const restrictedCors = cors({
    origin: config.allowedOrigins ? config.allowedOrigins.split(',') : true,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
});

// Lazy-init Razorpay: secrets aren't available at module load time
let razorpay: InstanceType<typeof Razorpay>;
function getRazorpay() {
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
        if (event.event.startsWith('item.') || event.event.startsWith('plan.')) {
            await handleProductEvent(event);
        } else if (event.event.startsWith('subscription.')) {
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

// ---------- Verify Order (restricted CORS + rate limit + auth) ----------
app.get('/verify-order/:orderId', restrictedCors, rateLimit, authenticate, async (req: AuthenticatedRequest, res: Response) => {
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

                // Use transaction to enforce state machine
                await db.runTransaction(async (t) => {
                    const doc = await t.get(docRef);
                    const currentStatus = doc.exists ? doc.data()?.status : null;

                    if (isTerminalSessionStatus(currentStatus)) return;

                    t.set(docRef, {
                        status: 'paid',
                        order_id: order.id,
                        updated_at: FieldValue.serverTimestamp(),
                    }, { merge: true });
                });
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

// ---------- Verify Payment (restricted CORS + rate limit + auth) ----------
app.post('/verify-payment', restrictedCors, rateLimit, authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature, razorpay_subscription_id, sessionId } = req.body;

        let isValid = false;

        if (razorpay_order_id || razorpay_subscription_id) {
            isValid = validatePaymentVerification({
                order_id: razorpay_order_id,
                payment_id: razorpay_payment_id,
                subscription_id: razorpay_subscription_id
            }, razorpay_signature, config.razorpayKeySecret);
        }

        if (!isValid) {
            res.status(400).json({ status: 'FAILED', message: 'Signature mismatch or missing parameters.' });
            return;
        }

        // If it's an order payment, sync it to the session proactively
        if (razorpay_order_id && sessionId && req.user?.uid) {
            const db = admin.firestore();
            const docRef = db.collection(config.customersCollectionPath)
                .doc(req.user.uid)
                .collection('checkout_sessions')
                .doc(sessionId);

            // Ownership + state machine check inside transaction
            await db.runTransaction(async (t) => {
                const doc = await t.get(docRef);

                if (!doc.exists) {
                    throw new Error('Session does not exist.');
                }

                const data = doc.data();

                // Ownership: ensure the order_id matches
                if (data?.order_id && data.order_id !== razorpay_order_id) {
                    throw new Error('Order ID mismatch.');
                }

                if (isTerminalSessionStatus(data?.status)) return;

                t.set(docRef, {
                    status: 'paid',
                    order_id: razorpay_order_id,
                    payment_id: razorpay_payment_id,
                    updated_at: FieldValue.serverTimestamp(),
                }, { merge: true });
            });
        }

        res.status(200).json({ status: 'PASSED' });
    } catch (err: any) {
        logs.error(err);
        // Sanitized error: don't leak internal details
        res.status(500).json({ status: 'FAILED', message: 'Verification failed. Please try again.' });
    }
});

export default app;
