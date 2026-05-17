# 04. Subscriptions & Plan Management

This guide explains how to set up recurring billing and subscription systems. It details the administrative tools to sync and create plans, the Firestore structure for subscriptions, and the callable functions for client-side subscription management.

---

## 🛠️ 1. Plan Management & Administrative APIs

The extension includes two secure **HTTPS Callable Functions** to handle plan synchronization between your Razorpay Dashboard and Cloud Firestore:
1.  **`createPlan`**: Creates a recurring plan on Razorpay and writes/merges it into your Firestore products catalog.
2.  **`syncPlans`**: Queries all active plans from your Razorpay Dashboard (with automatic pagination support) and synchronizes them to Firestore.

### 🔒 Admin Verification Guard

Both functions require administrative authentication. The caller must have the `admin` custom claim set in their Firebase Auth token:

```typescript
if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError(
        'permission-denied',
        'Must be an administrative user to initiate plan management.'
    );
}
```

### ➕ Administrative API: `createPlan`

To create a subscription plan, invoke the `createPlan` callable function with the required parameters:

```javascript
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions();
const createPlan = httpsCallable(functions, "ext-razorpay-payments-createPlan");

const result = await createPlan({
  period: "month", // "daily" | "weekly" | "month" | "yearly"
  interval: 1, // e.g. 1 month
  item: {
    name: "Developer Pro Plan",
    amount: 99900, // INR ₹999.00 (in paise)
    description: "Premium access to all courses and community support."
  },
  notes: {
    productId: "dev-pro-subscription", // Link to custom Firestore document ID
    firebaseRole: "pro_member" // Secure custom claim role assigned to subscribers
  }
});
```

---

## 📊 2. Synced Product Catalog Schema

When a plan is synced via `syncPlans` or created via `createPlan`, the extension groups individual Razorpay Plan IDs (e.g. monthly vs yearly plans) under a single Firestore product catalog document.

### 📄 Synced Catalog Product Schema
*   **Path**: `/products/{productId}`
*   **Document ID**: Derived from `notes.productId`, or generated as kebab-case of the plan name (e.g. `developer-pro-plan`).

```json
{
  "id": "developer-pro-plan",
  "name": "Developer Pro Plan",
  "description": "Premium access to all courses and community support.",
  "active": true,
  "type": "subscription",
  "firebaseRole": "pro_member",
  "allowedPlans": {
    "month": "plan_Lxyz12345Monthly",
    "year": "plan_Labc67890Yearly"
  },
  "plans": {
    "month": {
      "id": "plan_Lxyz12345Monthly",
      "period": "month",
      "interval": 1,
      "item": {
        "name": "Developer Pro Plan",
        "amount": 99900,
        "description": "Premium access..."
      }
    },
    "year": {
      "id": "plan_Labc67890Yearly",
      "period": "year",
      "interval": 1,
      "item": {
        "name": "Developer Pro Plan - Annual",
        "amount": 999000,
        "description": "Annual saving plan..."
      }
    }
  },
  "_synced_via": "admin_api",
  "updated_at": "server_timestamp"
}
```

---

## 🔁 3. Initiating Subscriptions (Client Writes)

To subscribe to a recurring plan, the client application writes a document containing a `productId` and an optional `interval` to the user's `subscriptions` subcollection.

### 📄 Client Subscription Trigger Schema
*   **Path**: `/customers/{uid}/subscriptions/{subscriptionDocId}`
*   **Client Permitted Fields**: `productId` and `interval` (e.g., `month` or `year`).

```json
{
  "productId": "developer-pro-plan",
  "interval": "month"
}
```

### 🔒 Subscription Processing Triggers

The `createSubscription` Cloud Function intercepts this document creation and processes it securely:

1.  **Plan ID Direct Override Guard**: Direct creation with `plan_id` in the document is rejected to prevent tampering:
    `Providing plan_id directly is not allowed. Provide productId and interval instead.`
2.  **Catalog-Driven Plan Resolution**: The function fetches the product document from the secure `/products` collection. It automatically resolves the Razorpay plan ID based on the client's requested `interval` (looks up `allowedPlans[interval]`). If only one plan is linked under the product, it uses that automatically as a fallback.
3.  **Secure Role Fetching**: Retrieves `firebaseRole` directly from the secure Firestore product catalog, mapping it to the subscription document to prepare for custom claim issuance.
4.  **Transaction Lock**: Sets status to `processing` inside a Firestore transaction.
5.  **Razorpay API Subscription Call**: Issues a subscription creation request to Razorpay, locking quantity to `1` and notes to `{ uid, subscriptionId, productId }`.
6.  **Firestore Sync**: Writes the subscription ID, short redirect URL, and charge metadata back to the document:

```json
{
  "subscription_id": "sub_Mxyz123Xyz",
  "plan_id": "plan_Lxyz12345Monthly",
  "status": "created",
  "short_url": "https://rzp.io/i/sub_Mxyz123Xyz",
  "current_start": 1716301234,
  "current_end": 1718893234,
  "charge_at": 1716301234,
  "firebaseRole": "pro_member",
  "created_at": "server_timestamp"
}
```

7.  **Client Redirect**: Your client application, listening to the subscription document, reads the `short_url` and redirects the user to the Razorpay Hosted Subscriptions Checkout page to authorize billing.

---

## 💳 4. Managing Active Subscriptions

The extension exposes two client-callable functions to allow users to modify their active subscriptions:

### Cancel Subscription: `cancelSubscription`

Allows users to terminate their subscriptions at the end of the current billing cycle:

```javascript
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions();
const cancelSubscription = httpsCallable(functions, "ext-razorpay-payments-cancelSubscription");

await cancelSubscription({ subscriptionId: "sub_Mxyz123Xyz" });
// The subscription status is synced to 'cancelled' upon webhook callback
```

### Update Plan / Billing Cycle: `updateSubscriptionPlan`

Allows users to immediately upgrade or downgrade their active subscription plan:

```javascript
const updateSubscriptionPlan = httpsCallable(functions, "ext-razorpay-payments-updateSubscriptionPlan");

await updateSubscriptionPlan({
  subscriptionId: "sub_Mxyz123Xyz",
  planId: "plan_Labc67890Yearly" // Upgrading to Annual Plan ID
});
```

The subscription plan updates immediately (`schedule_change_at: 'now'`) via the Razorpay API, and the status maps back to Firestore.

---

## ⚡ Next Steps

Proceed to **[05. Webhook Configurations](./05-webhooks.md)** to see how incoming Razorpay webhook events are validated and synchronized to Firestore.
