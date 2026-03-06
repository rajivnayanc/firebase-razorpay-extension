import express, { Request, Response } from 'express';
import cors from 'cors';
import Razorpay from 'razorpay';
import * as admin from 'firebase-admin';
import { verifyWebhookSignature } from './security';
import config from './config';
import { logs } from './logs';

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

app.get('/verify-order/:orderId', async (req: Request, res: Response) => {
    try {
        const { orderId } = req.params;
        const order = await razorpay.orders.fetch(orderId);

        if (order.status === 'paid') {
            // Sync it to Firestore manually if webhook missed it
            const notes = order.notes as any;
            if (notes && notes.uid && notes.sessionId) {
                const db = admin.firestore();
                const docRef = db.collection(config.customersCollectionPath).doc(notes.uid).collection('checkout_sessions').doc(notes.sessionId);
                await docRef.set({ status: 'paid', order_id: order.id, payment_id: order.receipt }, { merge: true });
            }
        }

        res.status(200).json(order);
    } catch (err: any) {
        logs.error(err);
        res.status(500).send(err.message);
    }
});

export default app;
