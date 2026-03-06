import express, { Response } from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { verifyWebhookSignature } from './security';
import config from './config';
import { logs } from './logs';
import { authenticate, AuthenticatedRequest } from './middleware/authenticate';
import { isTerminalSessionStatus } from './stateMachine';
const { validatePaymentVerification } = require('razorpay/dist/utils/razorpay-utils');

import { handleProductEvent } from './handlers/products';
import { handleSubscriptionEvent } from './handlers/subscriptions';
import { handlePaymentEvent } from './handlers/payments';

const app = express();

// Middleware to keep raw string for signature validation
app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf.toString();
    }
}));

app.use(cors({ origin: true }));

const razorpay = new Razorpay({
    key_id: config.razorpayKeyId,
    key_secret: config.razorpayKeySecret,
});

app.post('/webhook', async (req: any, res: Response) => {
    const signature = req.headers['x-razorpay-signature'] as string;

    if (!verifyWebhookSignature(req.rawBody, signature)) {
        logs.invalidSignature();
        res.status(400).send('Invalid Signature');
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

        res.status(200).send('Webhook Processed');
    } catch (err: any) {
        logs.error(err);
        // Return 200 so razorpay doesnt retry forever on code errors, unless it's a network issue
        res.status(200).send('Webhook processing failed internally');
    }
});

// SECURED: Now requires Firebase Auth token
app.get('/verify-order/:orderId', authenticate, async (req: AuthenticatedRequest, res: Response) => {
    try {
        const { orderId } = req.params;
        const order = await razorpay.orders.fetch(orderId);

        if (order.status === 'paid') {
            const notes = order.notes as any;

            // Ownership check: ensure the order belongs to the authenticated user
            if (notes && notes.uid && notes.sessionId) {
                if (notes.uid !== req.user?.uid) {
                    res.status(403).json({ error: 'Order does not belong to authenticated user.' });
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

                    if (isTerminalSessionStatus(currentStatus)) return; // Don't overwrite terminal states

                    t.set(docRef, {
                        status: 'paid',
                        order_id: order.id,
                        updated_at: admin.firestore.FieldValue.serverTimestamp(),
                    }, { merge: true });
                });
            }
        }

        res.status(200).json(order);
    } catch (err: any) {
        logs.error(err);
        res.status(500).send(err.message);
    }
});

app.post('/verify-payment', authenticate, async (req: AuthenticatedRequest, res: Response) => {
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

                // Ownership: ensure the session belongs to the authenticated user
                // The doc path already contains req.user.uid, but double-check order_id matches
                if (data?.order_id && data.order_id !== razorpay_order_id) {
                    throw new Error('Order ID mismatch — possible tampering.');
                }

                if (isTerminalSessionStatus(data?.status)) return; // Already terminal

                t.set(docRef, {
                    status: 'paid',
                    order_id: razorpay_order_id,
                    payment_id: razorpay_payment_id,
                    updated_at: admin.firestore.FieldValue.serverTimestamp(),
                }, { merge: true });
            });
        }

        res.status(200).json({ status: 'PASSED' });
    } catch (err: any) {
        logs.error(err);
        res.status(500).json({ status: 'FAILED', message: err.message });
    }
});

export default app;
