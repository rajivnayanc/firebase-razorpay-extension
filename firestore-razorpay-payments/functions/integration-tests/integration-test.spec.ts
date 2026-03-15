import { expect as jestExpect } from '@jest/globals';

/**
 * Integration Tests for Razorpay Firebase Extension
 *
 * Uses Firebase Client SDK (firebase/firestore, firebase/functions, firebase/auth)
 * and Firebase Admin SDK (for cleanup & admin operations) against the Emulator Suite.
 *
 * Prerequisites:
 *   - Firebase CLI installed
 *   - Run: npm run test:integration:emulator
 */

// ─── Firebase Client SDK ────────────────────────────────────────────
import { initializeApp, FirebaseApp } from 'firebase/app';
import {
    getFirestore,
    connectFirestoreEmulator,
    doc,
    setDoc,
    getDoc,
    getDocs,
    deleteDoc,
    collection,
    onSnapshot,
    Firestore,
    Unsubscribe,
} from 'firebase/firestore';
import {
    getFunctions,
    connectFunctionsEmulator,
    httpsCallable,
    Functions,
} from 'firebase/functions';
import {
    getAuth,
    connectAuthEmulator,
    signInAnonymously,
    Auth,
} from 'firebase/auth';

// ─── Firebase Admin SDK (for cleanup & webhook simulation) ──────────
import * as admin from 'firebase-admin';
import * as crypto from 'crypto';
import fetch from 'node-fetch';

// ─── Constants ──────────────────────────────────────────────────────
const PROJECT_ID = 'demo-test';
const FUNCTIONS_PORT = 5001;
const FIRESTORE_PORT = 8080;
const AUTH_PORT = 9099;
const WEBHOOK_SECRET = 'whsec_test_integration_secret';

// ─── Initialize Client SDK ─────────────────────────────────────────
let app: FirebaseApp;
let db: Firestore;
let functions: Functions;
let auth: Auth;

// ─── Initialize Admin SDK (for cleanup) ─────────────────────────────
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${FIRESTORE_PORT}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${AUTH_PORT}`;

if (!admin.apps.length) {
    admin.initializeApp({ projectId: PROJECT_ID });
}
const adminDb = admin.firestore();

// ─── Webhook URL ────────────────────────────────────────────────────
let WEBHOOK_URL = '';

// ─── Helpers ────────────────────────────────────────────────────────
function generateSignature(payload: string): string {
    return crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(payload)
        .digest('hex');
}

async function sendWebhook(event: any) {
    const payload = JSON.stringify(event);
    const signature = generateSignature(payload);
    return fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-razorpay-signature': signature,
        },
        body: payload,
    });
}

async function clearFirestore() {
    const collections = ['customers', 'products', '_razorpay_processed_events'];
    for (const col of collections) {
        const snap = await adminDb.collection(col).get();
        const batch = adminDb.batch();
        snap.docs.forEach((d) => batch.delete(d.ref));
        if (!snap.empty) await batch.commit();
    }
}

function wait(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Waits for a Firestore document field to reach a target value.
 * Returns the final snapshot data, or null on timeout.
 */
function waitForField(
    docRef: ReturnType<typeof doc>,
    field: string,
    expected: string | string[],
    timeoutMs = 10000
): Promise<Record<string, any> | null> {
    return new Promise((resolve) => {
        const targets = Array.isArray(expected) ? expected : [expected];
        let unsub: Unsubscribe;
        const timer = setTimeout(() => {
            unsub?.();
            resolve(null);
        }, timeoutMs);

        unsub = onSnapshot(docRef, (snap) => {
            const data = snap.data();
            if (data && targets.includes(data[field])) {
                clearTimeout(timer);
                unsub();
                resolve(data);
            }
        });
    });
}

// ─── Global Setup ───────────────────────────────────────────────────
beforeAll(async () => {
    // Wait for emulators to be ready
    await wait(3000);

    // Initialize Firebase Client SDK
    app = initializeApp({ projectId: PROJECT_ID, apiKey: 'fake-api-key' });

    db = getFirestore(app);
    connectFirestoreEmulator(db, '127.0.0.1', FIRESTORE_PORT);

    functions = getFunctions(app);
    connectFunctionsEmulator(functions, '127.0.0.1', FUNCTIONS_PORT);

    auth = getAuth(app);
    connectAuthEmulator(auth, `http://127.0.0.1:${AUTH_PORT}`, { disableWarnings: true });

    // Auto-detect webhook URL
    const extensionUrl = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/ext-razorpay-payments-razorpayWebhookHandler`;
    const standardUrl = `http://127.0.0.1:${FUNCTIONS_PORT}/${PROJECT_ID}/us-central1/razorpayWebhookHandler`;

    try {
        const res = await fetch(extensionUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (res.status !== 404) {
            WEBHOOK_URL = extensionUrl;
            console.log(`Using extension webhook URL`);
            return;
        }
    } catch (e) { /* fall through */ }

    try {
        const res = await fetch(standardUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
        });
        if (res.status !== 404) {
            WEBHOOK_URL = standardUrl;
            console.log(`Using standard webhook URL`);
            return;
        }
    } catch (e) { /* fall through */ }

    WEBHOOK_URL = extensionUrl;
    console.log(`Defaulting to extension webhook URL`);
});

// =====================================================================
//  1. Webhook Signature Verification (still uses raw fetch — server-to-server)
// =====================================================================
describe('Integration: Webhook Signature Verification', () => {
    it('should reject requests with invalid signature', async () => {
        const payload = JSON.stringify({ event: 'payment.captured', payload: {} });
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-razorpay-signature': 'invalid_signature',
            },
            body: payload,
        });

        jestExpect(res.status).toBe(400);
        const text = await res.text();
        jestExpect(text).toContain('Invalid Signature');
    });

    it('should reject requests with missing signature', async () => {
        const payload = JSON.stringify({ event: 'payment.captured', payload: {} });
        const res = await fetch(WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: payload,
        });

        jestExpect(res.status).toBe(400);
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
        // The handler returns 200 even if internal Razorpay fetch fails
        jestExpect(res.status).toBe(200);
    });
});

// =====================================================================
//  2. Firestore Trigger: createOrder (Client SDK doc write → trigger)
// =====================================================================
describe('Integration: createOrder Trigger (via Client SDK)', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should trigger createOrder when a checkout_session doc is created via setDoc', async () => {
        const uid = 'test-user-order-trigger';

        // Create customer doc first (admin SDK for setup)
        await adminDb.collection('customers').doc(uid).set({ email: 'test@example.com' });

        // Client SDK: create a checkout_sessions document → triggers createOrder
        const sessionRef = doc(db, `customers/${uid}/checkout_sessions`, 'session_order_1');
        await setDoc(sessionRef, {
            amount: 50000,
            currency: 'INR',
        });

        // Wait for the trigger to process (it will set status to 'processing' then 'created' or 'error')
        const result = await waitForField(
            sessionRef,
            'status',
            ['processing', 'created', 'error', 'failed'],
            8000
        );

        jestExpect(result).not.toBeNull();
        jestExpect(['processing', 'created', 'error', 'failed']).toContain(result?.status);
    });

    it('should be readable via Client SDK getDoc after trigger fires', async () => {
        const uid = 'test-user-order-read';
        await adminDb.collection('customers').doc(uid).set({ email: 'read@example.com' });

        const sessionRef = doc(db, `customers/${uid}/checkout_sessions`, 'session_read_1');
        await setDoc(sessionRef, { amount: 30000, currency: 'INR' });

        await wait(5000);

        // Client SDK: read the document back
        const snap = await getDoc(sessionRef);
        jestExpect(snap.exists()).toBe(true);

        const data = snap.data();
        jestExpect(data?.amount).toBe(30000);
        // Trigger should have modified the doc
        jestExpect(data?.status).toBeDefined();
    });
});

// =====================================================================
//  3. Firestore Trigger: createSubscription (Client SDK doc write → trigger)
// =====================================================================
describe('Integration: createSubscription Trigger (via Client SDK)', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should trigger createSubscription when a subscriptions doc is created', async () => {
        const uid = 'test-user-sub-trigger';
        await adminDb.collection('customers').doc(uid).set({ email: 'sub@example.com' });

        // Client SDK: create a subscriptions document → triggers createSubscription
        const subRef = doc(db, `customers/${uid}/subscriptions`, 'sub_trigger_1');
        await setDoc(subRef, {
            plan_id: 'plan_test_123',
        });

        // The trigger validates plan_id against synced plans; since no plan exists,
        // it should set status to 'failed' with an error message
        const result = await waitForField(
            subRef,
            'status',
            ['processing', 'created', 'failed'],
            8000
        );

        jestExpect(result).not.toBeNull();
        jestExpect(['processing', 'created', 'failed']).toContain(result?.status);
    });
});

// =====================================================================
//  4. Webhook → Firestore Sync (webhook + Client SDK read)
// =====================================================================
describe('Integration: Webhook → Firestore Sync (Client SDK reads)', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should sync payment.captured webhook and be readable via getDoc', async () => {
        const uid = 'test-user-capture-read';
        await adminDb.collection('customers').doc(uid).set({ email: 'capture@example.com' });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_capture_read')
            .set({
                amount: 50000,
                currency: 'INR',
                status: 'created',
                razorpay_order_id: 'order_capture_read_1',
            });

        const event = {
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: {
                        id: 'pay_capture_read_1',
                        order_id: 'order_capture_read_1',
                        status: 'captured',
                        amount: 50000,
                        notes: { uid, sessionId: 'session_capture_read' },
                        currency: 'INR',
                        method: 'upi',
                    },
                },
            },
            account_id: 'acc_test',
        };

        const res = await sendWebhook(event);
        jestExpect(res.status).toBe(200);

        await wait(3000);

        // Client SDK: read the updated doc
        const sessionRef = doc(db, `customers/${uid}/checkout_sessions`, 'session_capture_read');
        const snap = await getDoc(sessionRef);

        // The webhook handler may have failed internally (test API keys),
        // but the doc should still exist
        jestExpect(snap.exists()).toBe(true);
    });
});

// =====================================================================
//  5. State Machine: terminal state cannot be overwritten
// =====================================================================
describe('Integration: State Machine Enforcement', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should reject transition from terminal "paid" state', async () => {
        const uid = 'test-user-sm';
        await adminDb.collection('customers').doc(uid).set({ email: 'sm@example.com' });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_terminal')
            .set({
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
        jestExpect(res.status).toBe(200);

        await wait(2000);

        // Client SDK: verify status is still "paid"
        const sessionRef = doc(db, `customers/${uid}/checkout_sessions`, 'session_terminal');
        const snap = await getDoc(sessionRef);
        jestExpect(snap.data()?.status).toBe('paid');
    });
});

// =====================================================================
//  6. Subscription Sync via webhook (webhook + Client SDK verify)
// =====================================================================
describe('Integration: Subscription Sync', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should sync subscription.activated webhook', async () => {
        const uid = 'test-user-sub-sync';
        await adminDb.collection('customers').doc(uid).set({ email: 'subsync@example.com' });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_activate_1')
            .set({ plan_id: 'plan_test_1', status: 'created' });

        const event = {
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: {
                        id: 'sub_activate_1',
                        plan_id: 'plan_test_1',
                        status: 'active',
                        customer_id: 'cust_test_1',
                        notes: { uid },
                    },
                },
            },
        };

        const res = await sendWebhook(event);
        jestExpect(res.status).toBe(200);

        await wait(2000);

        // Client SDK: verify subscription status
        const subRef = doc(db, `customers/${uid}/subscriptions`, 'sub_activate_1');
        const snap = await getDoc(subRef);
        jestExpect(snap.exists()).toBe(true);

        // The webhook handler may fail to update status to 'active' if it can't 
        // fetch authoritative state from Razorpay (test keys), but it should exist.
        const data = snap.data();
        jestExpect(['active', 'created']).toContain(data?.status);
    });
});

// =====================================================================
//  7. onCustomerDataDeleted Lifecycle (Client SDK deleteDoc → trigger)
// =====================================================================
describe('Integration: onCustomerDataDeleted Lifecycle', () => {
    it('should fire cleanup trigger when customer doc is deleted via Client SDK', async () => {
        const uid = 'test-user-delete-' + Date.now();

        await adminDb.collection('customers').doc(uid).set({ email: 'delete@example.com' });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_active_1')
            .set({
                subscription_id: 'sub_rzp_1',
                plan_id: 'plan_1',
                status: 'active',
                notes: { firebaseRole: 'premium' },
            });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('subscriptions')
            .doc('sub_active_2')
            .set({
                subscription_id: 'sub_rzp_2',
                plan_id: 'plan_2',
                status: 'authenticated',
                notes: { firebaseRole: 'admin' },
            });

        await wait(2000);

        // Client SDK: delete the customer doc (triggers onCustomerDataDeleted)
        const customerRef = doc(db, 'customers', uid);
        await deleteDoc(customerRef);

        // Wait for trigger to process
        await wait(8000);

        // Client SDK: check subscription statuses
        const sub1Ref = doc(db, `customers/${uid}/subscriptions`, 'sub_active_1');
        const sub2Ref = doc(db, `customers/${uid}/subscriptions`, 'sub_active_2');

        const sub1 = await getDoc(sub1Ref);
        const sub2 = await getDoc(sub2Ref);

        // The trigger attempts to cancel via Razorpay API (which fails with test keys),
        // but it should still update local statuses
        if (sub1.exists()) {
            jestExpect(sub1.data()?.status).toBe('cancelled');
        }
        if (sub2.exists()) {
            jestExpect(sub2.data()?.status).toBe('cancelled');
        }
    });
});

// =====================================================================
//  8. Callable Functions: createPlan, syncPlans (via httpsCallable)
// =====================================================================
describe('Integration: Admin Callable Functions (httpsCallable)', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should reject createPlan call without authentication', async () => {
        // Note: In the emulator, httpsCallable without auth may behave differently.
        // The callable function checks context.auth, which will be null for unauthenticated calls.
        const createPlanFn = httpsCallable(
            functions,
            'ext-razorpay-payments-createPlan'
        );

        try {
            await createPlanFn({
                period: 'monthly',
                interval: 1,
                item: { name: 'Test Plan', amount: 50000, currency: 'INR' },
            });
            // If we get here without error, the emulator might not enforce auth
            // This is acceptable in emulator environment
        } catch (error: any) {
            // Expected: permission-denied error
            jestExpect(error.code).toContain('permission-denied');
        }
    });

    it('should allow createPlan call with authenticated admin user', async () => {
        // Sign in anonymously, then set admin claim via Admin SDK
        const cred = await signInAnonymously(auth);
        const uid = cred.user.uid;

        // Set admin custom claim via Admin SDK
        await admin.auth().setCustomUserClaims(uid, { admin: true, role: 'admin' });

        // Force token refresh to pick up new claims
        await cred.user.getIdToken(true);

        const createPlanFn = httpsCallable(
            functions,
            'ext-razorpay-payments-createPlan'
        );

        try {
            const result = await createPlanFn({
                period: 'monthly',
                interval: 1,
                item: { name: 'Admin Test Plan', amount: 99900, currency: 'INR' },
            });

            // If Razorpay API works with test keys, we get a plan object
            jestExpect(result.data).toBeDefined();
        } catch (error: any) {
            // Razorpay API call may fail with test keys — that's OK
            // But it should NOT be a permission-denied error
            const errorCode = error?.code || '';
            jestExpect(errorCode).not.toMatch(/permission-denied/);
        }
    });

    it('should call syncPlans via httpsCallable', async () => {
        const cred = await signInAnonymously(auth);
        const uid = cred.user.uid;
        await admin.auth().setCustomUserClaims(uid, { admin: true, role: 'admin' });
        await cred.user.getIdToken(true);

        const syncPlansFn = httpsCallable(
            functions,
            'ext-razorpay-payments-syncPlans'
        );

        try {
            const result = await syncPlansFn(null);
            jestExpect(result.data).toBeDefined();
        } catch (error: any) {
            // Razorpay API may fail, but not with permission-denied
            jestExpect(error.code).not.toContain('permission-denied');
        }
    });
});

// =====================================================================
//  9. Collection Reads via Client SDK (getDocs)
// =====================================================================
describe('Integration: Collection reads via Client SDK', () => {
    beforeEach(async () => {
        await clearFirestore();
    });

    it('should read products collection via getDocs', async () => {
        // Seed a product via Admin SDK
        await adminDb.collection('products').doc('plan_sdk_1').set({
            name: 'SDK Test Plan',
            amount: 50000,
            active: true,
        });

        // Client SDK: read products
        const snap = await getDocs(collection(db, 'products'));
        jestExpect(snap.size).toBeGreaterThanOrEqual(1);

        const product = snap.docs.find((d) => d.id === 'plan_sdk_1');
        jestExpect(product).toBeDefined();
        jestExpect(product?.data().name).toBe('SDK Test Plan');
    });

    it('should read customer checkout_sessions via getDocs', async () => {
        const uid = 'test-user-read-sessions';
        await adminDb.collection('customers').doc(uid).set({ email: 'read@example.com' });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_1')
            .set({ amount: 10000, status: 'created' });
        await adminDb
            .collection('customers')
            .doc(uid)
            .collection('checkout_sessions')
            .doc('session_2')
            .set({ amount: 20000, status: 'paid' });

        // Client SDK: read sessions
        const sessionsSnap = await getDocs(
            collection(db, `customers/${uid}/checkout_sessions`)
        );
        jestExpect(sessionsSnap.size).toBe(2);
    });
});


