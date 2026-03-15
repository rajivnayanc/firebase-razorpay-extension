import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import { Orders } from 'razorpay/dist/types/orders';
import config from '../config';
import { logs } from '../logs';
import { getRazorpay } from '../api';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

export const createOrderHandler = async (event: any) => {
    logs.info('createOrderHandler');
    // When deployed as an extension, the trigger path is resolved by extension.yaml
    // and the `{customers_collection}` wildcard is replaced with the actual collection name.
    // In that case, `event.params.customers_collection` will be undefined.
    if (event.params.customers_collection && event.params.customers_collection !== config.customersCollectionPath) return;

    const snap = event.data;
    if (!snap) {
        logs.error(new Error('No data associated with the event'));
        return;
    }

    const currentData = snap.data();

    // Guard: This is a subscription session, not a one-time order
    // We exit early to avoid spinning up a transaction
    if (currentData.mode === 'subscription' || currentData.price || currentData.subscription_id) {
        return;
    }

    // Server-side amount validation
    if (!currentData.amount || currentData.amount <= 0) {
        await snap.ref.update({
            status: 'failed',
            error: 'Invalid amount: must be a positive integer (in paise)',
        });
        return;
    }

    // If order already created, paid, or has an order_id assigned, skip.
    if (currentData.order_id || currentData.status === 'created' || currentData.status === 'paid') {
        return;
    }

    if (currentData.status === 'processing') {
        const processingAt = currentData.processing_at?.toDate();
        if (processingAt && (Date.now() - processingAt.getTime()) < 120000) {
            return; // Still processing normally
        }
    }

    // Set processing
    await snap.ref.update({
        status: 'processing',
        processing_at: FieldValue.serverTimestamp(),
    });

    try {
        // Receipt-based duplicate check: use Firestore doc ID as receipt
        // If a previous attempt created an order with this receipt, reuse it
        const receipt = event.params.id;
        let order: Orders.RazorpayOrder;

        try {
            const existingOrders = await getRazorpay().orders.all({ receipt });
            const matchingOrder = existingOrders?.items?.find(
                (o: Orders.RazorpayOrder) => o.receipt === receipt && (o.status === 'created' || o.status === 'paid')
            );

            if (matchingOrder) {
                // Reuse existing order instead of creating a duplicate
                order = matchingOrder;
                logs.orderCreated(order.id, `${snap.ref.path} (reused existing)`);
            } else {
                // Create new Razorpay Order
                const options: Orders.RazorpayOrderCreateRequestBody = {
                    amount: currentData.amount,
                    currency: currentData.currency || 'INR',
                    receipt,
                    notes: {
                        uid: event.params.uid,
                        sessionId: event.params.id,
                    },
                };

                order = await getRazorpay().orders.create(options);
                logs.orderCreated(order.id, snap.ref.path);
            }
        } catch (fetchError: any) {
            // If the receipt lookup fails, fall back to creating a new order
            const options: Orders.RazorpayOrderCreateRequestBody = {
                amount: currentData.amount,
                currency: currentData.currency || 'INR',
                receipt,
                notes: {
                    uid: event.params.uid,
                    sessionId: event.params.id,
                },
            };

            order = await getRazorpay().orders.create(options);
            logs.orderCreated(order.id, snap.ref.path);
        }

        await snap.ref.update({
            ...order,
            order_id: order.id,
            status: 'created',
            created_at: FieldValue.serverTimestamp(),
        });

    } catch (error: any) {
        logs.error(error);
        await snap.ref.update({
            status: 'failed',
            error: error.message || 'Failed to create Razorpay Order',
        });
    }
};

export const createOrder = onDocumentCreated(
    `{customers_collection}/{uid}/checkout_sessions/{id}`,
    createOrderHandler
);
