import { FieldValue } from 'firebase-admin/firestore';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import * as admin from 'firebase-admin';
import Razorpay from 'razorpay';
import config from '../config';
import { logs } from '../logs';

// Initialize Firebase Admin if not already initialized
if (!admin.apps.length) {
    admin.initializeApp();
}

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


export const createSubscriptionHandler = async (event: any) => {
    // When deployed as an extension, the trigger path is resolved by extension.yaml
    // and the `{customers_collection}` wildcard is replaced with the actual collection name.
    // In that case, `event.params.customers_collection` will be undefined.
    if (event.params.customers_collection && event.params.customers_collection !== config.customersCollectionPath) return;

    const snap = event.data;
    if (!snap) {
        logs.error(new Error('No data associated with the event'));
        return;
    }

    const db = admin.firestore();

    // Use Firestore Transaction to prevent TOCTOU race condition
    // Two concurrent triggers cannot both acquire the "processing" lock
    let shouldCreateSubscription = false;
    let subscriptionData: any = null;
    let secureRole = '';

    try {
        await db.runTransaction(async (t) => {
            const docSnapshot = await t.get(snap.ref as admin.firestore.DocumentReference);
            const currentData = docSnapshot.data();

            // Guard: already has subscription or is in a non-initial state
            if (!currentData || currentData.subscription_id || currentData.status === 'created' || currentData.status === 'active') {
                return;
            }

            // If processing, check if it's stuck (e.g., > 2 minutes)
            if (currentData.status === 'processing') {
                const processingAt = currentData.processing_at?.toDate();
                if (processingAt && (Date.now() - processingAt.getTime()) < 120000) {
                    return; // Still processing normally
                }
                logs.info(`Retrying stuck subscription creation for ${event.params.id}`);
            }

            // Server-side validation: plan_id is required
            if (!currentData.plan_id) {
                t.update(snap.ref, {
                    status: 'failed',
                    error: 'Missing required field: plan_id',
                });
                return;
            }

            // Securely fetch the plan document to get the assigned firebaseRole
            const planRef = db.collection(config.productsCollectionPath).doc(currentData.plan_id);
            const planDoc = await t.get(planRef);

            if (planDoc.exists) {
                const planData = planDoc.data() || {};
                // Prefer the razorpay webhook synced notes field, fallback to manually set string
                secureRole = planData.razorpay_notes_firebaseRole || planData.firebaseRole || '';
            }

            // Acquire lock atomically
            t.update(snap.ref, {
                status: 'processing',
                processing_at: FieldValue.serverTimestamp(),
            });

            shouldCreateSubscription = true;
            subscriptionData = currentData;
        });

        if (!shouldCreateSubscription || !subscriptionData) return;

        // Create Razorpay Subscription (OUTSIDE transaction — external API calls must not be in transactions)
        const options = {
            plan_id: subscriptionData.plan_id,
            total_count: subscriptionData.total_count || 12,
            quantity: subscriptionData.quantity || 1,
            customer_id: subscriptionData.razorpay_customer_id,
            notes: {
                uid: event.params.uid,
                subscriptionId: event.params.id,
                firebaseRole: secureRole,
            },
        };

        const subscription = await getRazorpay().subscriptions.create(options);
        logs.subscriptionCreated(subscription.id, snap.ref.path);

        await snap.ref.update({
            subscription_id: subscription.id,
            status: subscription.status,
            short_url: subscription.short_url,
            created_at: FieldValue.serverTimestamp(),
        });

    } catch (error: any) {
        logs.error(error);
        await snap.ref.update({
            status: 'failed',
            error: error.message || 'Failed to create Razorpay Subscription',
        });
    }
};

export const createSubscription = onDocumentCreated(
    `{customers_collection}/{uid}/subscriptions/{id}`,
    createSubscriptionHandler
);
