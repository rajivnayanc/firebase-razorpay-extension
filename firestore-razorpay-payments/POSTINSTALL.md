# Post-Installation Instructions

The "Run Payments with Razorpay" extension has been successfully installed!

## Action Required: Configure Webhooks

To ensure your Firestore database is synced correctly with Razorpay, you must configure a Webhook in the Razorpay Dashboard.

1. Go to your [Razorpay Dashboard → Settings → Webhooks](https://dashboard.razorpay.com/app/webhooks).
2. Click **Add New Webhook**.
3. Set the **Webhook URL** to:
   `${function:razorpayWebhookHandler.url}/webhook`
4. Set the **Secret** to the exact Webhook Secret you entered during installation.
5. Select the following **Active Events**:
   - `order.paid`
   - `payment.captured`
   - `payment.failed`
   - `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.completed`, `subscription.pending`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.updated`
6. Click **Save**.

## How it works

### One-time payments

Write a document to the `${param:CUSTOMERS_COLLECTION}/{uid}/checkout_sessions` subcollection with a `productId` to create a Razorpay Order. The `amount` will be securely fetched from the backend:

```javascript
const docRef = await firebase.firestore()
  .collection('${param:CUSTOMERS_COLLECTION}')
  .doc(userId)
  .collection('checkout_sessions')
  .add({
    productId: 'prod_premium_shoes', // Document ID of the item in your products collection
  });

// Listen for the order ID
docRef.onSnapshot((snap) => {
  const { razorpay_order_id, status } = snap.data();
  if (razorpay_order_id) {
    // Open Razorpay Checkout with this order ID
  }
});
```

### Subscriptions

Write a document to the `${param:CUSTOMERS_COLLECTION}/{uid}/subscriptions` subcollection:

```javascript
await firebase.firestore()
  .collection('${param:CUSTOMERS_COLLECTION}')
  .doc(userId)
  .collection('subscriptions')
  .add({
    productId: 'prod_premium_membership', // Document ID in products collection
    interval: 'monthly', // Maps to the allowedPlans in your product document
  });
```

## Required Security Rules

> **⚠️ CRITICAL:** You MUST configure these Firestore Security Rules before going to production. Without them, any authenticated user can modify product prices and other users' data.

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── Products / Plans Catalog ──
    // Read-only for all users. Only the extension (Admin SDK) and admin
    // callable functions can write here.
    match /${param:PRODUCTS_COLLECTION}/{productId} {
      allow read: if true;
      allow write: if false;
    }

    // ── Customer Documents ──
    match /${param:CUSTOMERS_COLLECTION}/{uid} {
      // Users can only read their own customer document.
      // They should NOT be able to write to the root customer doc
      // (razorpay_customer_id is set by the extension).
      allow read: if request.auth.uid == uid;
      allow write: if false;

      // ── Checkout Sessions (One-time Orders) ──
      match /checkout_sessions/{id} {
        allow read: if request.auth.uid == uid;

        // Users can create a checkout session, but:
        //  - Cannot supply their own 'amount' (server-side lookup from products)
        //  - Cannot supply 'order_id' or 'status' (set by extension)
        //  - Must supply a 'productId'
        allow create: if request.auth.uid == uid
          && !("amount" in request.resource.data)
          && !("order_id" in request.resource.data)
          && !("status" in request.resource.data)
          && !("currency" in request.resource.data)
          && ("productId" in request.resource.data);

        // Only the extension (Admin SDK) updates checkout sessions
        allow update, delete: if false;
      }

      // ── Subscriptions ──
      match /subscriptions/{id} {
        allow read: if request.auth.uid == uid;

        // Users can create a subscription request, but:
        //  - Cannot supply their own 'plan_id' (resolved server-side from product)
        //  - Cannot supply 'subscription_id' or 'status'
        //  - Cannot supply 'customer_id' (fetched from their customer doc)
        //  - Must supply 'productId' and 'interval'
        allow create: if request.auth.uid == uid
          && !("plan_id" in request.resource.data)
          && !("subscription_id" in request.resource.data)
          && !("status" in request.resource.data)
          && !("customer_id" in request.resource.data)
          && !("total_count" in request.resource.data)
          && ("productId" in request.resource.data)
          && ("interval" in request.resource.data);

        // Only the extension (Admin SDK) updates subscriptions
        allow update, delete: if false;

        // Payment sub-documents under subscriptions
        match /payments/{paymentId} {
          allow read: if request.auth.uid == uid;
          allow write: if false;
        }
      }
    }

    // ── Deny everything else by default ──
    // No wildcard match — unlisted paths are denied
  }
}
```

### Admin Plan Management

Since Razorpay doesn't have plan webhooks, you must use the following admin endpoints to manage your catalog. Only users with the `admin: true` custom claim can access these.

#### Setting Admin Claims
The recommended way to bootstrap the first admin user is by using a short Node.js script using the Firebase Admin SDK. Run this script locally:

```javascript
const admin = require('firebase-admin');
// Initialize with your service account
admin.initializeApp({
  credential: admin.credential.applicationDefault() 
});

const uid = 'YOUR_USER_UID';
admin.auth().setCustomUserClaims(uid, { admin: true })
  .then(() => console.log('Admin claim set successfully!'));
```

---

#### `POST /admin/plans` & `POST /admin/plans/sync`
These are **Firebase Callable Functions** (not standard REST endpoints). They securely execute the plan creation and sync. You must call them from your client application using the standard Firebase SDK:

```javascript
import { getFunctions, httpsCallable } from "firebase/functions";
const functions = getFunctions();

// Sync all plans from Razorpay to your products collection
const syncPlans = httpsCallable(functions, "ext-razorpay-payments-syncPlans");
syncPlans().then(result => console.log("Synced Plans:", result.data.count));

// Create a new plan from the admin dashboard UI
const createPlan = httpsCallable(functions, "ext-razorpay-payments-createPlan");
createPlan({
  period: "monthly",
  interval: 1,
  item: { name: "Premium", amount: 50000, currency: "INR" }
});
```

### Role-based Access Control (Custom Claims)

You can automatically grant Firebase Auth custom claims to users when they subscribe to specific plans.

1. Open your Razorpay Dashboard and navigate to your **Plans**.
2. Add a new **Note** to the Plan. Set the key to `firebaseRole` and the value to the custom claim you want applied (e.g., `admin` or `premium`).
3. The extension will automatically set and remove this claim as the subscription lifecycle changes (activated, cancelled, etc.).

> **Security Note:** Custom claims are fetched from Razorpay directly to prevent privilege escalation. Do not pass the `firebaseRole` field from the client.



## Monitoring

To monitor the extension:

- **Cloud Functions logs**: View in the [Firebase Console](https://console.firebase.google.com/project/_/functions/logs) → Functions → Logs.
- **Firestore**: Check `${param:CUSTOMERS_COLLECTION}/{uid}/checkout_sessions` and `subscriptions` subcollections for current state.
- **Webhook health**: Monitor the extension's webhook function for errors or signature failures.

## Eventarc Events

If you enabled events during installation, this extension publishes the following custom events:

| Event Type | Description |
|---|---|
| `com.razorpay.v1.order.paid` | Order is paid |
| `com.razorpay.v1.payment.captured` | Payment captured |
| `com.razorpay.v1.payment.failed` | Payment failed |
| `com.razorpay.v1.subscription.authenticated` | Subscription authenticated |
| `com.razorpay.v1.subscription.activated` | Subscription activated |
| `com.razorpay.v1.subscription.charged` | Subscription charged |
| `com.razorpay.v1.subscription.completed` | Subscription completed |
| `com.razorpay.v1.subscription.pending` | Subscription pending |
| `com.razorpay.v1.subscription.halted` | Subscription halted |
| `com.razorpay.v1.subscription.paused` | Subscription paused |
| `com.razorpay.v1.subscription.resumed` | Subscription resumed |
| `com.razorpay.v1.subscription.updated` | Subscription updated |
| `com.razorpay.v1.subscription.cancelled` | Subscription cancelled |
