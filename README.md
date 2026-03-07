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
firebase ext:install AiTaskFlows/razorpay-payments --project=YOUR_PROJECT_ID
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

## Usage

### Create a one-time payment

Write a document to the `checkout_sessions` subcollection:

```javascript
const docRef = await firebase.firestore()
  .collection('customers')
  .doc(userId)
  .collection('checkout_sessions')
  .add({
    amount: 50000,      // Amount in paise (₹500.00)
    currency: 'INR',
    receipt: `order_${Date.now()}`,
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
    plan_id: 'plan_XXXXXXXXXXXXX',
    total_count: 12,
  });
```

## Webhook Setup

After installing, configure your Razorpay webhook:

1. Go to [Razorpay Dashboard → Settings → Webhooks](https://dashboard.razorpay.com/app/webhooks)
2. Add webhook URL: `https://<LOCATION>-<PROJECT_ID>.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler/webhook`
3. Select events: `payment.*`, `order.*`, `subscription.*`, `item.*`
4. Set the webhook secret to match your extension configuration

## Billing

This extension uses the following billable Firebase services:

- **Cloud Firestore** — document reads/writes for payment state
- **Cloud Functions** — function invocations for triggers and webhooks
- **Cloud Secret Manager** — secure storage of API keys
- **Firebase Authentication** — custom claims for subscribers

Third-party: [Razorpay pricing](https://razorpay.com/pricing)

## License

Apache-2.0
