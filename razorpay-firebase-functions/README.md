# @neocleus/razorpay-firebase-functions

Consumable Firebase Cloud Functions for **Razorpay** payments and subscriptions integration using the Factory pattern.

This package provides the core server-side integration triggers and callable handlers for the **Run Payments with Razorpay** Firebase Extension. It can be initialized directly inside your own custom Cloud Functions codebase.

---

## 📥 Installation

Install the package in your Firebase Cloud Functions directory:

```bash
npm install @neocleus/razorpay-firebase-functions
```

---

## ⚙️ Quick Start & Initialization

Import `initializeRazorpay` and call it with your API credentials to export all triggers, callable functions, and webhook handlers.

### `src/index.ts`
```typescript
import * as admin from 'firebase-admin';
import { initializeRazorpay } from '@neocleus/razorpay-firebase-functions';

// 1. Initialize the Firebase Admin SDK
admin.initializeApp();

// 2. Configure and initialize Razorpay functions
const rzpFuncs = initializeRazorpay({
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    customersCollection: 'customers', // Optional, defaults to 'customers'
    productsCollection: 'products',   // Optional, defaults to 'products'
    plansCollection: 'plans',         // Optional, defaults to 'plans'
    syncCustomers: true,              // Optional, defaults to true
    
    // Callback to process backend business logic (e.g. grant/revoke AI credits)
    onCheckoutSessionUpdate: async (uid, session, paymentDetails) => {
        if (session.status === 'paid') {
            console.log(`User ${uid} successfully paid for checkout session ${session.id}`);
        }
    },
    onSubscriptionUpdate: async (uid, subscription, subscriptionDetails) => {
        console.log(`Subscription ${subscription.id} for user ${uid} transitioned to: ${subscription.status}`);
    }
});

// 3. Export functions as flat deployable Cloud Functions
export const createOrder = rzpFuncs.createOrder;
export const createSubscription = rzpFuncs.createSubscription;
export const createCustomer = rzpFuncs.createCustomer;
export const onUserDeleted = rzpFuncs.onUserDeleted;
export const onCustomerDataDeleted = rzpFuncs.onCustomerDataDeleted;
export const webhookHandler = rzpFuncs.webhookHandler;
export const cancelSubscription = rzpFuncs.cancelSubscription;
export const updateSubscriptionPlan = rzpFuncs.updateSubscriptionPlan;
export const createPlan = rzpFuncs.createPlan;
export const syncPlans = rzpFuncs.syncPlans;
export const createProduct = rzpFuncs.createProduct;
```

---

## 🛡️ Robust Initialization Guard

To prevent silent deployment configuration errors, `initializeRazorpay` validates your keys during initialization. 

If any required credential is missing (`keyId`, `keySecret`, or `webhookSecret`) or if the `keyId` does not start with the mandatory `rzp_` prefix, **the function immediately throws a runtime Error**. This prevents your Cloud Functions from deploying in a misconfigured state.

---

## 🛠️ Exported Functions Reference

1.  **Firestore Lifecycle Triggers**:
    *   `createOrder`: Watches `customers/{uid}/checkout_sessions/{id}` to securely generate orders on Razorpay's API with transaction locks and duplicate safeguards.
    *   `createSubscription`: Watches `customers/{uid}/subscriptions/{id}` to register subscription sessions on Razorpay's API.
2.  **Auth Triggers**:
    *   `createCustomer`: Listens to `auth.user().onCreate` to lazily sync users into Razorpay.
    *   `onUserDeleted` / `onCustomerDataDeleted`: Cleans up documents and references.
3.  **HTTPS Webhook Handler**:
    *   `webhookHandler`: Deploys as an HTTPS endpoint to listen to Razorpay webhook events. Hardened with HMAC signature checks, deterministic event-ID deduplication, and stuck-event processing recovery.
4.  **Client Callables**:
    *   `cancelSubscription`: Handles secure cancellation requests.
    *   `updateSubscriptionPlan`: Handles secure plan upgrades/downgrades, validating target `planId` against the products catalog collection.
5.  **Admin Callables**:
    *   `createPlan` / `syncPlans` / `createProduct`: Enabled for users with custom claims (`admin: true`) to batch-sync catalogs or directly define products/plans using high-performance Firestore write operations.

---

## 🔒 Security Guidelines

*   **Production Credentials**: Never commit plaintext API keys to Git. Configure these variables inside Google Cloud Secret Manager and load them dynamically in production.
*   **Git Ignore Rules**: Add `.env` and `*.secret.local` to your ignore list:
    ```
    **/functions/.env
    **/*.secret.local
    ```

### 📄 Required Firestore Security Rules

To enforce catalog-driven pricing, protect payment states, and prevent metadata spoofing, you must apply the following security rules in your `firestore.rules` file:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── Products / Plans Catalog ──
    match /products/{productId} {
      allow read: if true;
      allow write: if false;
    }
    match /plans/{planId} {
      allow read, write: if false;
    }

    // ── Customer Documents ──
    match /customers/{uid} {
      allow read: if request.auth.uid == uid;
      allow write: if false;

      // ── Checkout Sessions (One-time Orders) ──
      match /checkout_sessions/{id} {
        allow read: if request.auth.uid == uid;
        allow create: if request.auth.uid == uid
          && request.resource.data.keys().hasOnly(['productId', 'metadata'])
          && request.resource.data.productId is string
          && request.resource.data.productId.size() <= 256
          && (!('metadata' in request.resource.data) || request.resource.data.metadata is map)
          && request.resource.data.keys().size() <= 5;

        allow update, delete: if false;

        match /razorpay_responses/{docId} {
          allow read: if request.auth.uid == uid;
          allow write: if false;
        }
      }

      // ── Subscriptions ──
      match /subscriptions/{id} {
        allow read: if request.auth.uid == uid;
        allow create: if request.auth.uid == uid
          && request.resource.data.keys().hasOnly(['productId', 'interval', 'metadata', 'draftId'])
          && request.resource.data.productId is string
          && request.resource.data.productId.size() <= 256
          && request.resource.data.interval is string
          && request.resource.data.interval.size() <= 64
          && (!('metadata' in request.resource.data) || request.resource.data.metadata is map)
          && (!('draftId' in request.resource.data) || request.resource.data.draftId is string)
          && request.resource.data.keys().size() <= 5;

        allow update, delete: if false;

        match /payments/{paymentId} {
          allow read: if request.auth.uid == uid;
          allow write: if false;
        }

        match /razorpay_responses/{docId} {
          allow read: if request.auth.uid == uid;
          allow write: if false;
        }
      }
    }

    // ── Webhook Events (Backend/Extension Only) ──
    match /webhook_events/{eventId} {
      allow read, write: if false;
    }

    // ── Deny everything else by default ──
    // No wildcard match — unlisted paths are denied
  }
}
```
