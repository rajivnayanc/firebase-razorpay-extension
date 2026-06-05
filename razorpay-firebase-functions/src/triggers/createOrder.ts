import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { Orders } from 'razorpay/dist/types/orders';
import { logs } from '../logs';
import { RazorpaySyncConfig } from '../types';
import { ensureRazorpayCustomer } from '../utils/ensureCustomer';
import { acquireProcessingLock } from '../utils/processingLock';

export const buildCreateOrder = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    const createOrderHandler = async (event: any) => {
        logs.info('createOrderHandler');
        const snap = event.data;
        if (!snap) {
            logs.error(new Error('No data associated with the event'));
            return;
        }

        const currentData = snap.data();

        // Guard: This is a subscription session, not a one-time order
        if (currentData.mode === 'subscription' || currentData.price || currentData.subscription_id) {
            return;
        }

        // Server-side amount validation
        if (currentData.amount) {
            await snap.ref.update({
                status: 'failed',
                error: 'Providing amount directly is not allowed. Provide a productId instead.',
            });
            return;
        }

        if (!currentData.productId || typeof currentData.productId !== 'string' || currentData.productId.length > 256) {
            await snap.ref.update({
                status: 'failed',
                error: 'Missing or invalid productId. A valid productId string must be provided.',
            });
            return;
        }

        const productSnap = await admin.firestore().collection(config.productsCollection).doc(currentData.productId).get();
        if (!productSnap.exists) {
            logs.error(new Error(`Product ${currentData.productId} not found.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product is not available.',
            });
            return;
        }

        const productData = productSnap.data();
        if (!productData || !productData.amount || productData.amount <= 0) {
            logs.error(new Error(`Product ${currentData.productId} has invalid amount: ${productData?.amount}`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product has an invalid configuration.',
            });
            return;
        }
        const orderAmount = productData.amount;
        const orderCurrency = productData.currency || 'INR';

        // Acquire processing lock to prevent race conditions
        const shouldProcess = await acquireProcessingLock(
            snap.ref as admin.firestore.DocumentReference,
            (data) => !!(data.order_id || data.status === 'created' || data.status === 'paid')
        );

        if (!shouldProcess) {
            return;
        }

        // Lazy Customer Creation via shared utility
        try {
            await ensureRazorpayCustomer(event.params.uid, config, rzp);
        } catch (customerError: any) {
            const errMsg = customerError instanceof Error ? customerError.message : (typeof customerError === 'object' ? JSON.stringify(customerError) : String(customerError));
            logs.error(new Error(`Failed to dynamically create Razorpay customer: ${errMsg}`));
        }

        try {
            const receipt = event.params.id.substring(0, 40);
            let order: Orders.RazorpayOrder;

            const options: Orders.RazorpayOrderCreateRequestBody = {
                amount: orderAmount,
                currency: orderCurrency,
                receipt,
                notes: {
                    uid: event.params.uid,
                    sessionId: event.params.id,
                    productId: currentData.productId,
                },
            };

            order = await rzp.orders.create(options);
            logs.orderCreated(order.id, snap.ref.path);

            await snap.ref.update({
                order_id: order.id,
                amount: order.amount,
                amount_paid: order.amount_paid,
                amount_due: order.amount_due,
                currency: order.currency,
                receipt: order.receipt,
                status: 'created',
                created_at: FieldValue.serverTimestamp(),
            });

        } catch (error: any) {
            logs.error(error);
            await snap.ref.update({
                status: 'failed',
                error: 'Failed to create Razorpay Order due to an internal error or validation issue',
            });
        }
    };

    return onDocumentCreated(
        `${config.customersCollection}/{uid}/checkout_sessions/{id}`,
        createOrderHandler
    );
};
