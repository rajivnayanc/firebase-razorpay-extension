import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { FieldValue } from 'firebase-admin/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import { Orders } from 'razorpay/dist/types/orders';
import { logs } from '../logs';
import { RazorpaySyncConfig, CheckoutSessionDoc } from '../types';
import { ensureRazorpayCustomer } from '../utils/ensureCustomer';
import { acquireProcessingLock } from '../utils/processingLock';
import { TypedFirestore } from '../utils/typedFirestore';

export const buildCreateOrder = (config: RazorpaySyncConfig, rzp: Razorpay) => {
    const createOrderHandler = async (event: any) => {
        logs.info('createOrderHandler');
        const snap = event.data;
        if (!snap) {
            logs.error(new Error('No data associated with the event'));
            return;
        }

        const currentData = snap.data() as CheckoutSessionDoc | undefined;
        if (!currentData) return;

        // Guard: This is already processed or paid
        if (currentData.status === 'created' || currentData.status === 'paid') {
            return;
        }

        // Validate productId
        if (!currentData.productId || typeof currentData.productId !== 'string' || currentData.productId.length > 256) {
            await snap.ref.update({
                status: 'failed',
                error: 'Missing or invalid productId. A valid productId string must be provided.',
            });
            return;
        }

        const typedFs = new TypedFirestore(admin.firestore(), config);
        const productSnap = await typedFs.getProductDoc(currentData.productId).get();
        if (!productSnap.exists) {
            logs.error(new Error(`Product ${currentData.productId} not found.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product is not available.',
            });
            return;
        }

        const productData = productSnap.data();
        if (!productData || !productData.active) {
            logs.error(new Error(`Product ${currentData.productId} is inactive or invalid.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product is not available.',
            });
            return;
        }

        // Guard: Verify it's a one-time product
        if (productData.type === 'subscription') {
            logs.error(new Error(`Product ${currentData.productId} is a subscription product, but used in checkout_sessions.`));
            await snap.ref.update({
                status: 'failed',
                error: 'The selected product requires a subscription.',
            });
            return;
        }

        if (!productData.amount || productData.amount <= 0) {
            logs.error(new Error(`Product ${currentData.productId} has invalid amount: ${productData.amount}`));
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
            (data) => !!(data.status === 'created' || data.status === 'paid')
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

            // Enforce only string key-value pairs for Razorpay notes metadata
            const notesMetadata: Record<string, string> = {};
            if (currentData.metadata) {
                for (const [key, value] of Object.entries(currentData.metadata)) {
                    notesMetadata[key] = String(value).substring(0, 512);
                }
            }

            const options: Orders.RazorpayOrderCreateRequestBody = {
                amount: orderAmount,
                currency: orderCurrency,
                receipt,
                notes: {
                    uid: event.params.uid,
                    sessionId: event.params.id,
                    productId: currentData.productId,
                    ...notesMetadata,
                },
            };

            order = await rzp.orders.create(options);
            logs.orderCreated(order.id, snap.ref.path);

            // Write the raw order response to a separate subcollection document
            const orderDocRef = typedFs.getCheckoutSessionOrderDoc(event.params.uid, event.params.id);
            await orderDocRef.set(order);

            // Update main document status and timestamps only
            await snap.ref.update({
                status: 'created',
                updated_at: FieldValue.serverTimestamp(),
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
