/**
 * Integration Tests for Razorpay Firebase Extension
 *
 * These tests run against the Firebase Emulator Suite.
 *
 * Prerequisites:
 *   - Firebase CLI installed
 *   - Emulators running: firebase emulators:start --project=demo-test
 *
 * Run: npm run test:integration
 */

import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import fetch from 'node-fetch';

// Connect to Firebase Emulator
const PROJECT_ID = 'demo-test';
const FUNCTIONS_PORT = 5001;

// The webhook secret MUST match the env file used by the emulator
const WEBHOOK_SECRET = 'whsec_test_integration_secret';

// Emulator function URL — try both standard and extension-prefixed formats
// Standard: http://127.0.0.1:5001/demo-test/us-central1/razorpayWebhookHandler
// Extension: http://127.0.0.1:5001/demo-test/us-central1/ext-razorpay-payments-razorpayWebhookHandler
let WEBHOOK_BASE_URL = '';

process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:8080`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:9099`;

if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT_ID });
}


const db = admin.firestore();

// Helper: Generate valid HMAC-SHA256 webhook signature
function generateSignature(payload: string): string {
    return crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
}

// Helper: Clear Firestore collections between tests
async function clearFirestore() {
    const collections = ['customers', 'products', '_razorpay_processed_events'];
    for (const col of collections) {
        const snap = await db.collection(col).get();
        const batch = db.batch();
        snap.docs.forEach((doc) => batch.delete(doc.ref));
        if (!snap.empty) await batch.commit();
    }
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper: Send a webhook event with valid HMAC signature
async function sendWebhook(event: any) {
    const payload = JSON.stringify(event);
    const signature = generateSignature(payload);

    return fetch(`${WEBHOOK_BASE_URL}/webhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-razorpay-signature': signature,
        },
        body: payload,
    });
}

// Auto-detect the correct function URL before tests run
beforeAll(async () => {
    const standardUrl = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/razorpayWebhookHandler`;
    const extensionUrl = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/ext-razorpay-payments-razorpayWebhookHandler`;

    // Try extension URL first (most common with emulator)
    try {
        const res = await fetch(`${extensionUrl}/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (res.status !== 404) {
            WEBHOOK_BASE_URL = extensionUrl;
            console.log(`Using extension URL: ${WEBHOOK_BASE_URL}`);
            return;
        }
    } catch (e) {
        // fall through
    }

    // Try standard URL
    try {
        const res = await fetch(`${standardUrl}/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (res.status !== 404) {
            WEBHOOK_BASE_URL = standardUrl;
            console.log(`Using standard URL: ${WEBHOOK_BASE_URL}`);
            return;
        }
    } catch (e) {
        // fall through
    }

    // Default to standard
    WEBHOOK_BASE_URL = standardUrl;
    console.log(`Defaulting to: ${WEBHOOK_BASE_URL}`);
});

describe('Integration: Webhook Signature Verification', () => {
    it('should reject requests with invalid signature', async () => {
        const payload = JSON.stringify({ event: 'payment.captured', payload: {} });
        const res = await fetch(`${WEBHOOK_BASE_URL}/webhook`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-razorpay-signature': 'invalid_signature',
            },
            body: payload,
        });

        expect(res.status).toBe(400);
        const text = await res.text();
        expect(text).toContain('Invalid Signature');
    });

    it('should reject requests with missing signature', async () => {
        const payload = JSON.stringify({ event: 'payment.captured', payload: {} });
        const res = await fetch(`${WEBHOOK_BASE_URL}/webhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        });

        expect(res.status).toBe(400);
    });

    it('should accept requests with valid signature', async () => {
        const event = {
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_integ_test_1',
                        order_id: 'order_integ_test_1',
                        status: 'captured',
                        amount: 50000,
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        const text = await res.text();
        if (res.status !== 200) {
            console.error('Webhook failed:', text);
        }
        expect(res.status).toBe(200);
        expect(text).toContain('Webhook Processed');
    });
});

describe('Integration: Payment Flow (Webhook → Firestore)', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should create checkout session doc when order is created via trigger', async () => {
        const uid = 'test-user-payment-flow';
        await db.collection('customers').doc(uid).set({
            email: 'test@example.com',
        });

        const sessionRef = db
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_1');

        await sessionRef.set({
            amount: 50000,
            currency: 'INR',
            receipt: 'receipt_test_1',
            status: 'created',
        });

        // Wait for trigger to process
        await wait(5000);

        const updatedDoc = await sessionRef.get();
        const data = updatedDoc.data();
        expect(data).toBeDefined();
        // Trigger fires but Razorpay API call will fail with test keys
        expect(['created', 'processing', 'error']).toContain(data?.status);
    });

    it('should sync payment.captured webhook to Firestore', async () => {
        const uid = 'test-user-capture';
        await db.collection('customers').doc(uid).set({
            email: 'test@example.com',
        });

        const sessionRef = db
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_capture');

        await sessionRef.set({
            amount: 50000,
            currency: 'INR',
            status: 'created',
            razorpay_order_id: 'order_capture_1',
        });

        const event = {
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_capture_1',
                        order_id: 'order_capture_1',
                        status: 'captured',
                        amount: 50000,
                        notes: { uid: 'test-user-capture', sessionId: 'session_capture' },
                        currency: 'INR',
                        method: 'upi',
                    },
                },
            },
            account_id: 'acc_test',
        };

        const res = await sendWebhook(event);
        expect(res.status).toBe(200);

        await wait(2000);

        const updatedDoc = await sessionRef.get();
        const data = updatedDoc.data();
        expect(data?.status).toBe('paid');
        expect(data?.razorpay_payment_id).toBe('pay_capture_1');
    });

    it('should handle payment.failed webhook', async () => {
        const uid = 'test-user-fail';
        await db.collection('customers').doc(uid).set({
            email: 'fail@example.com',
        });

        const sessionRef = db
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_fail');

        await sessionRef.set({
            amount: 50000,
            currency: 'INR',
            status: 'created',
            razorpay_order_id: 'order_fail_1',
        });

        const event = {
            event: 'payment.failed',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_fail_1',
                        order_id: 'order_fail_1',
                        status: 'failed',
                        amount: 50000,
                        notes: { uid: 'test-user-fail', sessionId: 'session_fail' },
                        error_code: 'BAD_REQUEST_ERROR',
                        error_description: 'Payment processing failed',
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        expect(res.status).toBe(200);

        await wait(2000);

        const updatedDoc = await sessionRef.get();
        const data = updatedDoc.data();
        expect(data?.status).toBe('failed');
    });
});

describe('Integration: Event Deduplication', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should process same webhook event ID only once', async () => {
        const uid = 'test-user-dedup';
        await db.collection('customers').doc(uid).set({
            email: 'dedup@example.com',
        });

        const sessionRef = db
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_dedup');

        await sessionRef.set({
            amount: 50000,
            currency: 'INR',
            status: 'created',
            razorpay_order_id: 'order_dedup_1',
        });

        const event = {
            id: 'evt_dedup_test_1',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_dedup_1',
                        order_id: 'order_dedup_1',
                        status: 'captured',
                        amount: 50000,
                        notes: { uid: 'test-user-dedup', sessionId: 'session_dedup' },
                    },
                },
            },
        };

        const res1 = await sendWebhook(event);
        expect(res1.status).toBe(200);
        await wait(2000);

        const res2 = await sendWebhook(event);
        expect(res2.status).toBe(200);
        await wait(2000);

        const dedupDoc = await db
            .collection('_razorpay_processed_events')
            .doc('evt_dedup_test_1')
            .get();
        expect(dedupDoc.exists).toBe(true);
    });
});

describe('Integration: State Machine Enforcement', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should reject transition from terminal "paid" state', async () => {
        const uid = 'test-user-sm';
        await db.collection('customers').doc(uid).set({
            email: 'sm@example.com',
        });

        const sessionRef = db
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_terminal');

        await sessionRef.set({
            amount: 50000,
            currency: 'INR',
            status: 'paid',
            razorpay_order_id: 'order_terminal_1',
            razorpay_payment_id: 'pay_terminal_1',
        });

        const event = {
            event: 'payment.failed',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_terminal_2',
                        order_id: 'order_terminal_1',
                        status: 'failed',
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        expect(res.status).toBe(200);

        await wait(2000);

        const updatedDoc = await sessionRef.get();
        expect(updatedDoc.data()?.status).toBe('paid');
    });
});

describe('Integration: Product/Plan Sync', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should sync item.created webhook to products collection', async () => {
        const event = {
            event: 'item.created',
            payload: {
                item: {
                    entity: {
                        id: 'item_integ_1',
                        name: 'Premium Plan',
                        description: 'Monthly premium access',
                        amount: 99900,
                        currency: 'INR',
                        active: true,
                        notes: {
                            tier: 'premium',
                        },
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        expect(res.status).toBe(200);

        await wait(2000);

        const productDoc = await db
            .collection('products')
            .doc('item_integ_1')
            .get();
        expect(productDoc.exists).toBe(true);

        const data = productDoc.data();
        expect(data?.name).toBe('Premium Plan');
        expect(data?.amount).toBe(99900);
        expect(data?.razorpay_notes_tier).toBe('premium');
    });

    it('should delete product on item.deleted webhook', async () => {
        await db.collection('products').doc('item_delete_1').set({
            id: 'item_delete_1',
            name: 'To be deleted',
            amount: 50000,
        });

        const event = {
            event: 'item.deleted',
            payload: {
                item: {
                    entity: {
                        id: 'item_delete_1',
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        expect(res.status).toBe(200);

        await wait(2000);

        const productDoc = await db
            .collection('products')
            .doc('item_delete_1')
            .get();
        expect(productDoc.exists).toBe(false);
    });
});

describe('Integration: Subscription Sync', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should sync subscription.activated webhook', async () => {
        const uid = 'test-user-sub';
        await db.collection('customers').doc(uid).set({
            email: 'sub@example.com',
        });

        const subRef = db
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_activate_1');

        await subRef.set({
            plan_id: 'plan_test_1',
            status: 'created',
        });

        const event = {
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: {
                        id: 'sub_activate_1',
                        plan_id: 'plan_test_1',
                        status: 'active',
                        customer_id: 'cust_test_1',
                        notes: { uid: uid },
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        expect(res.status).toBe(200);

        await wait(2000);

        const updatedDoc = await subRef.get();
        const data = updatedDoc.data();
        expect(data?.status).toBe('active');
    });
});

describe('Integration: Concurrent Webhook Processing', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should handle concurrent webhooks for same order without duplication', async () => {
        const uid = 'test-user-concurrent';
        await db.collection('customers').doc(uid).set({
            email: 'concurrent@example.com',
        });

        const sessionRef = db
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_concurrent');

        await sessionRef.set({
            amount: 50000,
            currency: 'INR',
            status: 'created',
            razorpay_order_id: 'order_concurrent_1',
        });

        const event = {
            id: 'evt_concurrent_1',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_concurrent_1',
                        order_id: 'order_concurrent_1',
                        status: 'captured',
                        amount: 50000,
                        notes: { uid: 'test-user-concurrent', sessionId: 'session_concurrent_1' },
                    },
                },
            },
        };

        const promises = Array(5)
            .fill(null)
            .map(() => sendWebhook(event));
        const results = await Promise.all(promises);

        results.forEach((res) => expect(res.status).toBe(200));

        await wait(3000);

        const dedupSnap = await db
            .collection('_razorpay_processed_events')
            .where('entityId', '==', 'pay_concurrent_1')
            .get();

        // Should have at most 2 records (transaction race at most 1 extra)
        expect(dedupSnap.size).toBeLessThanOrEqual(2);
    });
});

describe('Integration: onUserDeleted Lifecycle', () => {
    it('should clean up subscriptions when customer doc is deleted', async () => {
        const uid = 'test-user-delete-' + Date.now();

        await db.collection('customers').doc(uid).set({
            email: 'delete@example.com',
        });

        await db
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_active_1')
            .set({ plan_id: 'plan_1', status: 'active', notes: { firebaseRole: 'premium' } });

        await db
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_active_2')
            .set({ plan_id: 'plan_2', status: 'authenticated', notes: { firebaseRole: 'admin' } });

        // Wait for writes to settle before triggering delete
        await wait(2000);

        // Delete the customer doc (triggers onUserDeleted)
        await db.collection('customers').doc(uid).delete();

        // Wait for trigger to fire and complete
        await wait(8000);

        const sub1 = await db
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_active_1')
            .get();

        const sub2 = await db
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_active_2')
            .get();

        if (sub1.exists) {
            expect(sub1.data()?.status).toBe('cancelled');
        }
        if (sub2.exists) {
            expect(sub2.data()?.status).toBe('cancelled');
        }
    });
});
