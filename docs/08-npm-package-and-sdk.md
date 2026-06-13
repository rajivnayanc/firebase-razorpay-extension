# 08. Npm Package & Web SDK Integration

This guide provides a comprehensive developer reference for installing, configuring, and utilizing the consumable backend npm package (`@neocleus/razorpay-firebase-functions`) and the client-side Web SDK (`@neocleus/razorpay-firebase-web-sdk`) in custom applications.

---

## 📦 1. Backend Package: `@neocleus/razorpay-firebase-functions`

The backend package provides the core business logic, Firestore triggers, HTTP webhook endpoints, and client callables packaged under a simple Factory initialization pattern.

### 📥 Installation

Install the package alongside the required Firebase Peer Dependencies in your Firebase Functions project directory:

```bash
npm install @neocleus/razorpay-firebase-functions
```

### ⚙️ Initialization & Configuration

Import `initializeRazorpay` and call it with your credentials to generate the complete suite of Firebase Functions triggers and handlers.

#### `functions/src/index.ts`
```typescript
import * as admin from 'firebase-admin';
import { initializeRazorpay } from '@neocleus/razorpay-firebase-functions';

// Initialize the Admin SDK
admin.initializeApp();

// Configure and initialize Razorpay functions
const rzpFuncs = initializeRazorpay({
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
    customersCollection: 'customers', // Optional, defaults to 'customers'
    productsCollection: 'products',   // Optional, defaults to 'products'
    plansCollection: 'plans',         // Optional, defaults to 'plans'
    syncCustomers: true,              // Optional, defaults to true

    // Direct callback triggers on webhook updates (e.g. status changes or success)
    onCheckoutSessionUpdate: async (uid, session, paymentDetails) => {
        if (session.status === 'paid') {
            const db = admin.firestore();
            const userRef = db.collection('users').doc(uid);
            const creditsToAdd = session.productId === 'credit-pack-100' ? 100 : 0;
            if (creditsToAdd > 0) {
                await userRef.update({
                    credits: admin.firestore.FieldValue.increment(creditsToAdd)
                });
            }
        }
    },
    onSubscriptionUpdate: async (uid, subscription, subscriptionDetails) => {
        const db = admin.firestore();
        const userRef = db.collection('users').doc(uid);
        if (subscription.status === 'active') {
            await userRef.update({ tier: 'premium' });
        } else if (subscription.status === 'cancelled') {
            await userRef.update({ tier: 'free' });
        }
    }
});

// Export functions to make them flat deployable Cloud Functions
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

#### 📦 Export Options: Flat vs. Namespaced (Grouped)
To expose the functions for deployment, you can choose between two export modes:

1. **Flat Exports (Default)**
   Export each function property individually. This deploys them as flat root-level functions. The Web SDK will call callables using their plain names (e.g. `cancelSubscription`).
   ```typescript
   export const createOrder = rzpFuncs.createOrder;
   export const createSubscription = rzpFuncs.createSubscription;
   export const cancelSubscription = rzpFuncs.cancelSubscription;
   export const updateSubscriptionPlan = rzpFuncs.updateSubscriptionPlan;
   // ... export other triggers and callables as needed ...
   ```

2. **Namespaced / Grouped Exports (Recommended to prevent missing exports)**
   Export the entire object as a single namespace. This ensures all triggers, webhook handlers, and callables are automatically exported without risking missing one.
   ```typescript
   export const rzp = initializeRazorpay({ ... });
   ```
   *Note: Firebase deploys these grouped functions prefixed with the group name (e.g., `rzp-cancelSubscription`). To support this, you must configure `functionPrefix: 'rzp'` in the client Web SDK config.*

---

### 📝 Parameter Reference: `RazorpayUserConfig`

The `initializeRazorpay` factory accepts a configuration object matching the following structure:

| Parameter | Type | Required | Description |
| :--- | :--- | :--- | :--- |
| `keyId` | `string` | **Yes** | Your client-facing Razorpay Key ID. Must start with `rzp_`. |
| `keySecret` | `string` | **Yes** | Your private Razorpay Key Secret. |
| `webhookSecret` | `string` | **Yes** | Webhook secret key configured in the Razorpay Webhook Dashboard. |
| `customersCollection` | `string` | No | Firestore collection path where customer metadata is synchronized. Defaults to `'customers'`. |
| `productsCollection` | `string` | No | Firestore collection path where products catalog is stored. Defaults to `'products'`. |
| `plansCollection` | `string` | No | Firestore collection path where subscription plans are synchronized. Defaults to `'plans'`. |
| `syncCustomers` | `boolean` | No | Automatically synchronizes customers on Auth user creation. Defaults to `true`. |
| `onCheckoutSessionUpdate` | `OnCheckoutSessionUpdate` | No | Callback triggered when a checkout session status updates. |
| `onSubscriptionUpdate` | `OnSubscriptionUpdate` | No | Callback triggered when a subscription status updates. |

> [!IMPORTANT]
> **Strict Error Checks**: The factory validates the configuration during function startup. If `keyId`, `keySecret`, or `webhookSecret` are missing, or if the `keyId` format is invalid (e.g. doesn't start with `rzp_`), **initialization throws a runtime Error immediately**. This prevents functions from deploying in a silently broken state.

---

### 🛠️ Exported Triggers & Handlers

The returned object contains the following pre-built functions ready for deployment:

1.  **Firestore Triggers**:
    *   `createOrder`: Listens to `customers/{uid}/checkout_sessions/{id}` document creation to generate Razorpay orders.
    *   `createSubscription`: Listens to `customers/{uid}/subscriptions/{id}` document creation to generate Razorpay subscription links.
2.  **Authentication Lifecycle Triggers**:
    *   `createCustomer`: Listens to `auth.user().onCreate` to register customers in Razorpay.
    *   `onUserDeleted` / `onCustomerDataDeleted`: Cleans up subscription documents and synchronizes customer deletions.
3.  **HTTPS Webhook Endpoint**:
    *   `webhookHandler`: Deploys as an HTTPS endpoint to receive webhook payloads from Razorpay. Processes events securely with HMAC signature checks and deterministic idempotency locks.
4.  **Secure Client Callables**:
    *   `cancelSubscription`: Gated user function to terminate active subscriptions.
    *   `updateSubscriptionPlan`: Securely validates plan upgrades/downgrades against allowed plans before updating.
5.  **Administrative Callables**:
    *   `createPlan` / `syncPlans` / `createProduct`: Restricted to users with custom admin claims (`admin: true`). Enables syncing products, registering plans, or manually managing direct one-time/subscription shell definitions in Firestore.

---

## 💻 2. Client SDK: `@neocleus/razorpay-firebase-web-sdk`

The Web SDK simplifies client integration by handling collection listeners, callable invocations, and launching the Razorpay Checkout popup overlay.

### 📥 Installation

Install the Web SDK package in your frontend project directory:

```bash
npm install @neocleus/razorpay-firebase-web-sdk
```

---

### ⚙️ React Hook Initialization

Initialize the SDK by calling `useRazorpayPayments` with your Firebase client instances:

```typescript
import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { useRazorpayPayments } from '@neocleus/razorpay-firebase-web-sdk';

const firebaseApp = initializeApp({ /* ...config */ });
const firestore = getFirestore(firebaseApp);
const auth = getAuth(firebaseApp);
const functions = getFunctions(firebaseApp);

export function CheckoutComponent() {
  const { startCheckout, startSubscription } = useRazorpayPayments({
    firestore,
    auth,
    functions,
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '', // Do NOT hardcode test keys!
    customersCollection: 'customers', // Optional, defaults to 'customers'
    productsCollection: 'products',   // Optional, defaults to 'products'
    functionPrefix: 'rzp'              // Optional, required if functions are exported in a namespace scope
  });
  
  // Use startCheckout and startSubscription in event handlers...
}
```

---

### 🛒 One-Time Checkout Flow: `startCheckout`

Launches a popup checkout flow for a one-time purchase.

```typescript
const handleCheckout = async () => {
  try {
    const result = await startCheckout({
      productId: 'premium-ebook-pack',
      metadata: {
        promo: 'summer_sale_2026',
        source: 'landing_page'
      },
      prefill: {
        name: 'Jane Doe',
        email: 'janedoe@example.com',
        contact: '+919999999999'
      },
      themeColor: '#1363DF' // Custom brand hex color
    });

    if (result.status === 'paid') {
      alert('Checkout completed and verified successfully!');
    } else {
      alert('Checkout failed or expired.');
    }
  } catch (error) {
    console.error('Checkout failed:', error);
  }
};
```

#### Option Reference: `startCheckout`
*   `productId` (`string`): The Firestore document ID slug of the product to purchase.
*   `metadata` (`Record<string, string>`): Optional custom key-value pairs (maximum 12 keys, values under 512 characters).
*   `prefill` (`object`): Optional user profile fields (`name`, `email`, `contact`) to prefill in the checkout popup.
*   `themeColor` (`string`): Optional hex code for checkout styling.

---

### 💳 Subscription Checkout Flow: `startSubscription`

Launches the checkout flow for recurring memberships.

```typescript
const handleSubscription = async () => {
  try {
    const result = await startSubscription({
      productId: 'pro-membership',
      interval: 'monthly', // Optional, specifies billing plan duration
      metadata: {
        referral: 'partner_referral_id'
      },
      prefill: {
        name: 'Jane Doe',
        email: 'janedoe@example.com'
      },
      themeColor: '#1363DF'
    });

    if (result.status === 'active' || result.status === 'authenticated') {
      alert('Subscription successfully set up! Your account is now active.');
    } else {
      alert('Subscription setup failed.');
    }
  } catch (error) {
    console.error('Subscription failed:', error);
  }
};
```

---

## 🔒 3. Crucial Security & Credential Guidelines

To maintain a secure implementation, adhere strictly to the following credential principles:

### ⚠️ Public Credentials (Client-Side)
*   **The Razorpay `keyId` is public**: It is exposed to client-side bundles so that the Razorpay popup can authenticate your account for checkout widgets.
*   **Prevent fallbacks**: Never hardcode fallback credentials in your code (e.g. `process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || 'rzp_test_fallback'`). Always load this value dynamically. Hardcoded keys can leak to version control and are baked into the client javascript bundle.

### ⛔ Private Credentials (Server-Side)
*   **Razorpay Key Secret and Webhook Secret are highly sensitive**: Anyone with access to your `keySecret` can perform administrative refunds, make direct payments, and alter account billing configurations.
*   **Google Cloud Secret Manager**: In production deployments, configure these values exclusively inside Google Cloud Secret Manager (`type: secret` in `extension.yaml`). Do not store them in plaintext files, configurations, or repositories.
*   **Git Ignore Rules**: Always add `.env`, `.env.local`, and `*.secret.local` to your `.gitignore` rules recursively to avoid accidental credential commits:
    ```
    **/functions/.env
    **/*.secret.local
    **/*.env.local
    ```
