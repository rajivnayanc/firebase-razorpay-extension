# Post-Installation Instructions

The "Run Payments with Razorpay" extension has been successfully installed!

## Action Required: Configure Webhooks

To ensure your Firestore database is synced correctly with Razorpay, you must configure a Webhook in the Razorpay Dashboard.

1. Go to your [Razorpay Dashboard → Settings → Webhooks](https://dashboard.razorpay.com/app/webhooks).
2. Click **Add New Webhook**.
3. Set the **Webhook URL** to:
   - **Production:** `${function:razorpayWebhookHandler.url}`
   - **Local Emulator Testing:** `http://localhost:5001/${param:PROJECT_ID}/${param:LOCATION}/razorpayWebhookHandler` (or your ngrok forwarding URL)
4. Set the **Secret** to the exact Webhook Secret you configured during installation.
5. Select the following **Active Events**:
   - **Payments:** `payment.authorized`, `payment.captured`, `payment.failed`
   - **Disputes:** `payment.dispute.created`, `payment.dispute.won`, `payment.dispute.lost`, `payment.dispute.closed`, `payment.dispute.under_review`, `payment.dispute.action_required`
   - **Downtimes:** `payment.downtime.started`, `payment.downtime.updated`, `payment.downtime.resolved`
   - **Orders:** `order.paid`, `order.notification.delivered`, `order.notification.failed`
   - **Subscriptions:** `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.completed`, `subscription.pending`, `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.updated`, `subscription.cancelled`
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

> [!IMPORTANT]
> **Note Injection Protection & Session Hijacking Prevention:**
> The backend handlers in this extension verify the `order_id` or `subscription_id` to prevent malicious clients from inserting another user's session IDs (session hijacking/note injection). 
> For this protection to be effective, **the client must NEVER be allowed to write or update fields like `order_id`, `subscription_id`, `amount`, `status`, or `currency`**. 
> - The Rules below enforce this by strictly restricting `create` operations and completely disabling client `update` and `delete` operations (`allow update, delete: if false;`) on checkout sessions and subscriptions. The extension's admin functions bypass these rules securely.

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
        //  - Only allowed fields: productId, metadata
        //  - Fields must be type/size validated
        allow create: if request.auth.uid == uid
          && request.resource.data.keys().hasOnly(['productId', 'metadata'])
          && request.resource.data.productId is string
          && request.resource.data.productId.size() <= 256
          && (!('metadata' in request.resource.data) || request.resource.data.metadata is map)
          && request.resource.data.keys().size() <= 5;

        // Only the extension (Admin SDK) updates checkout sessions
        allow update, delete: if false;

        // Response documents from Razorpay (created by backend)
        match /razorpay_responses/{docId} {
          allow read: if request.auth.uid == uid;
          allow write: if false;
        }
      }

      // ── Subscriptions ──
      match /subscriptions/{id} {
        allow read: if request.auth.uid == uid;

        // Users can create a subscription request, but:
        //  - Only allowed fields: productId, interval, metadata, draftId
        //  - Fields must be type/size validated
        allow create: if request.auth.uid == uid
          && request.resource.data.keys().hasOnly(['productId', 'interval', 'metadata', 'draftId'])
          && request.resource.data.productId is string
          && request.resource.data.productId.size() <= 256
          && request.resource.data.interval is string
          && request.resource.data.interval.size() <= 64
          && (!('metadata' in request.resource.data) || request.resource.data.metadata is map)
          && (!('draftId' in request.resource.data) || request.resource.data.draftId is string)
          && request.resource.data.keys().size() <= 5;

        // Only the extension (Admin SDK) updates subscriptions
        allow update, delete: if false;

        // Payment sub-documents under subscriptions
        match /payments/{paymentId} {
          allow read: if request.auth.uid == uid;
          allow write: if false;
        }

        // Response documents from Razorpay (created by backend)
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

### Catalog Management & Product Creation

To allow users to purchase premium subscriptions or one-time upgrades, you must build a product catalog in your `${param:PRODUCTS_COLLECTION}` collection. The extension supports two different product types:

> [!TIP]
> **Understanding `productId`:**
> The `productId` you pass when initiating a purchase (in checkout sessions or subscriptions) is simply the **Firestore Document ID** of the product inside your `${param:PRODUCTS_COLLECTION}` collection.
> * If you write a product at `/products/one_time_premium`, its `productId` is `one_time_premium`.
> * If a plan is synced or created at `/products/monthly_subscription`, its `productId` is `monthly_subscription`.

---

#### 1. One-Time Products (One-Time Purchases)
One-Time Products represent digital items, physical goods, or permanent premium upgrades (e.g. lifetime access). 
* **How to create:** You can create one-time products directly in the `${param:PRODUCTS_COLLECTION}` collection. Because client-side writes should be restricted by Firestore rules, you should use the Firebase Admin SDK (e.g. via a secure Cloud Function or Admin endpoint) to write these documents:

**Firestore Document Path:** `/${param:PRODUCTS_COLLECTION}/[product_id]`
```json
{
  "active": true,
  "name": "Lifetime Gold Membership",
  "description": "Unlock premium lifetime privileges with zero recurring subscription fees.",
  "amount": 499900,  // ₹4,999.00 (in paise, representing the base unit of the currency)
  "currency": "INR",
  "type": "one-time",
  "firebaseRole": "GoldPremium" // Optional: custom Auth role to grant on successful payment
}
```

---

#### 2. Subscription Products (Recurring Plans)
Subscription Products represent recurring billing plans (e.g. Monthly Premium, Annual VIP).
* **How to create:** Subscriptions require corresponding plans to exist inside your Razorpay Dashboard. The extension exposes two admin-secured Firebase Callable Functions to easily synchronize and manage plans:

##### Setting Admin Claims
To call these administrative functions, your developer user account must have the `admin: true` Custom Claim. Bootstrap your first admin user with a local script:

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

##### Creating Subscription Plans in Razorpay & Firestore
Call the `createPlan` callable function from your administrative dashboard UI. This creates the plan inside Razorpay and automatically triggers a sync to your products collection:

```javascript
import { getFunctions, httpsCallable } from "firebase/functions";
const functions = getFunctions();

const createPlan = httpsCallable(functions, "ext-razorpay-payments-createPlan");
createPlan({
  period: "monthly", // monthly, yearly, weekly, daily
  interval: 1,      // every 1 month
  item: { 
    name: "Premium Subscription", 
    amount: 50000,    // ₹500.00 (in paise)
    currency: "INR" 
  }
}).then(result => console.log("Created Subscription Plan ID:", result.data.id));
```

##### Syncing Existing Plans from Razorpay
If you already have plans configured in your Razorpay Dashboard, you can fetch and sync them all directly to Firestore in one call:

```javascript
const syncPlans = httpsCallable(functions, "ext-razorpay-payments-syncPlans");
syncPlans().then(result => console.log("Successfully synced", result.data.count, "plans to Firestore"));
```

**Resulting Firestore Document Path:** `/${param:PRODUCTS_COLLECTION}/[product_name_or_id]`
```json
{
  "active": true,
  "name": "Premium Subscription",
  "description": "Monthly subscription plan",
  "type": "subscription",
  "firebaseRole": "Premium", // Custom role mapped to this subscription
  "allowedPlans": {
    "monthly": "plan_XYZ1234567890" // Maps billing intervals to Razorpay Plan IDs
  }
}
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
| `com.razorpay.v1.payment.authorized` | Payment authorized |
| `com.razorpay.v1.payment.captured` | Payment captured |
| `com.razorpay.v1.payment.failed` | Payment failed |
| `com.razorpay.v1.payment.dispute.created` | Dispute created |
| `com.razorpay.v1.payment.dispute.won` | Dispute won |
| `com.razorpay.v1.payment.dispute.lost` | Dispute lost |
| `com.razorpay.v1.payment.dispute.closed` | Dispute closed |
| `com.razorpay.v1.payment.dispute.under_review` | Dispute under review |
| `com.razorpay.v1.payment.dispute.action_required` | Dispute action required |
| `com.razorpay.v1.payment.downtime.started` | Payment gateway downtime started |
| `com.razorpay.v1.payment.downtime.updated` | Payment gateway downtime updated |
| `com.razorpay.v1.payment.downtime.resolved` | Payment gateway downtime resolved |
| `com.razorpay.v1.order.paid` | Order is paid |
| `com.razorpay.v1.order.notification.delivered` | Order notification delivered to customer |
| `com.razorpay.v1.order.notification.failed` | Order notification failed to deliver |
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
