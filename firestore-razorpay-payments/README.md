# Run Payments with Razorpay

**Author**: Rajiv · **Version**: 1.0.0

A Firebase Extension that integrates [Razorpay](https://razorpay.com) payments with your Firebase project. Synchronizes customers, orders, subscriptions, and product catalogs to Cloud Firestore with idempotent webhook processing.

## Features

- **One-time payments**: Automatically creates Razorpay Orders when checkout session documents are added to Firestore.
- **Recurring subscriptions**: Creates Razorpay Subscriptions from Firestore documents with plan references.
- **Real-time sync**: Webhooks keep payment status, subscription state, and product catalogs in sync.
- **Idempotent processing**: Three-layer protection — Firestore Transactions, state machine enforcement, and event deduplication.
- **Security hardened**: Webhook signature verification, rate limiting, CORS restrictions, and error sanitization.
- **Role-based access**: Sets Firebase Authentication custom claims based on active subscriptions.
- **User lifecycle**: Automatically cleans up subscriptions and claims when users are deleted.
- **Extensible**: Publishes Eventarc custom events (`com.razorpay.v1.*`) for downstream processing.

## Prerequisites

- Firebase project on the **Blaze (pay-as-you-go)** plan.
- A [Razorpay account](https://dashboard.razorpay.com) with API keys.
- Cloud Firestore database created in your project.

## Installation

### Firebase Console

Install from the [Firebase Extensions Hub](https://extensions.dev) by searching for "Run Payments with Razorpay".

### Firebase CLI

```bash
firebase ext:install rajivnayanc/firebase-razorpay-extension/firestore-razorpay-payments --project=YOUR_PROJECT_ID
```

## Configuration

During installation, you'll configure:

| Parameter | Description |
|---|---|
| **Razorpay Key ID** | Your API Key ID from the Razorpay Dashboard |
| **Razorpay Key Secret** | Your API Key Secret |
| **Webhook Secret** | The secret configured in Razorpay's webhook settings |
| **Customer Collection** | Firestore collection for customer data (default: `customers`) |
| **Products Collection** | Firestore collection for product/plan sync (default: `products`) |
| **Allowed Origins** | CORS origins for client-facing endpoints |
| **Location** | Cloud Functions deployment region |

## Catalog Configuration

To enable checkouts, you must configure products/plans inside your Firestore `products` collection:

> [!TIP]
> **Understanding `productId`:**
> The `productId` you pass when initiating a purchase (in checkout sessions or subscriptions) is simply the **Firestore Document ID** of the product inside your `/products` collection.
> * If you create a product at `/products/one_time_premium`, its `productId` is `one_time_premium`.
> * If a plan is synced or created at `/products/monthly_subscription`, its `productId` is `monthly_subscription`.

### 1. One-Time Product
**Firestore Document Path:** `/products/[product_id]`
```json
{
  "active": true,
  "name": "Lifetime Premium Upgrade",
  "description": "Permanent access to VIP features.",
  "amount": 499900,  // ₹4,999.00 (in paise)
  "currency": "INR",
  "type": "one-time",
  "firebaseRole": "Premium"
}
```

### 2. Subscription Product
**Firestore Document Path:** `/products/[product_id]`
```json
{
  "active": true,
  "name": "Premium Subscription",
  "description": "Monthly recurring access.",
  "type": "subscription",
  "firebaseRole": "Premium",
  "allowedPlans": {
    "monthly": "plan_XYZ123456789" // Razorpay Plan ID
  }
}
```

## Usage

### Create a one-time payment

Write a document to the `checkout_sessions` subcollection with a `productId`:

```javascript
const docRef = await firebase.firestore()
  .collection('customers')
  .doc(userId)
  .collection('checkout_sessions')
  .add({
    productId: 'prod_premium_shoes', // ID of the product in your products collection
    currency: 'INR'
  });

// Listen for the order creation
docRef.onSnapshot((snap) => {
  const data = snap.data();
  if (data.razorpay_order_id) {
    // Use data.razorpay_order_id with Razorpay Checkout
  }
});
```

### Create a subscription

```javascript
await firebase.firestore()
  .collection('customers')
  .doc(userId)
  .collection('subscriptions')
  .add({
    productId: 'prod_premium_membership', // Allowed product ID
    interval: 'monthly', // Billing interval
  });
```

### Role-based Access Control (Custom Claims)

This extension can automatically manage Firebase Authentication custom claims based on a user's subscription status.

To configure this:
1. In the Razorpay Dashboard, edit your **Plan** and add an internal Note.
2. Set the key to `firebaseRole` and the value to the role you want to grant (e.g., `premium`).
3. When a user subscribes to this plan, they will automatically be granted the `premium` custom claim. If the subscription is cancelled or halted, the claim is automatically removed.
4. If a user's account is deleted, the extension cleans up all dynamically granted custom claims.

## Webhook Setup

After installing, configure your Razorpay webhook to synchronize payment statuses in real-time:

1. Go to your [Razorpay Dashboard → Settings → Webhooks](https://dashboard.razorpay.com/app/webhooks).
2. Click **Add New Webhook**.
3. Set the **Webhook URL** to:
   - **Production:** `https://<LOCATION>-<PROJECT_ID>.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler`
   - **Local Emulator:** `http://localhost:5001/demo-test/us-central1/razorpayWebhookHandler`
4. Set the **Secret** to the exact Webhook Secret you configured during installation.
5. Select the following **Active Events**:
   - **Payments:** `payment.authorized`, `payment.captured`, `payment.failed`
   - **Disputes:** `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `payment.dispute.under_review`, `payment.dispute.action_required`
   - **Downtimes:** `payment.downtime.started`, `payment.downtime.updated`, `payment.downtime.resolved`
   - **Orders:** `order.paid`, `order.notification.delivered`, `order.notification.failed`
   - **Subscriptions:** `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.completed`, `subscription.pending`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.updated`, `subscription.cancelled`
6. Click **Save**.

## Billing

This extension uses the following billable Firebase services:

- **Cloud Firestore** — document reads/writes for payment state
- **Cloud Functions** — function invocations for triggers and webhooks
- **Cloud Secret Manager** — secure storage of API keys
- **Firebase Authentication** — custom claims for subscribers

Third-party: [Razorpay pricing](https://razorpay.com/pricing)

## License

Apache-2.0
