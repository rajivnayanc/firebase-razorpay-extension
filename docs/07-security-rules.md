# 07. Production-Ready Firestore Security Rules

To ensure that your payment configurations are highly secure, you must configure **Cloud Firestore Security Rules**. This prevents malicious clients from bypassing pricing structures, editing payment statuses, or reading other users' private subscriptions.

---

## 🛡️ Security Design Principles

The security model of the Razorpay Firebase Extension is based on the following access principles:

1.  **Read-Only Catalog**: Clients can read active items from the `/products` collection but cannot create, update, or delete products.
2.  **Owner-Only Session Access**: Users can read and write checkout sessions and subscriptions only under their own path (`/customers/{uid}`).
3.  **Strict Write Fields**:
    *   For **Checkout Sessions**: Clients can only write a `productId` when creating a document. They cannot provide an `amount`, `currency`, or custom `status` (such as `paid`).
    *   For **Subscriptions**: Clients can only write a `productId` and `interval`. They cannot write a `plan_id` or custom `status` (such as `active`).
4.  **No Client Updates**: Clients cannot modify existing session or subscription documents. All state transitions (updating status to `paid` or `active`) are handled exclusively by the server-side Cloud Functions running with admin privileges.
5.  **Total Webhook Event Isolation**: The `webhook_events` collection is entirely isolated. Clients are strictly forbidden from reading or writing to this collection, preventing event spoofing.

---

## 📄 Production Firestore Security Rules

Copy and paste this configuration directly into your `firestore.rules` file:

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Helper: Verify if the user is authenticated and matches the document UID
    function isOwner(uid) {
      return request.auth != null && request.auth.uid == uid;
    }

    // Helper: Verify if the user has an administrative claim
    function isAdmin() {
      return request.auth != null && request.auth.token.admin == true;
    }

    // ==========================================
    // 📦 Products & Synced Plans Collection
    // ==========================================
    match /products/{productId} {
      // Anyone can read active products/plans in the catalog
      allow read: if resource.data.active == true;
      
      // Only administrative users can create or modify products/plans directly
      allow write: if isAdmin();
    }

    // ==========================================
    // 👤 Customers & Private Sub-collections
    // ==========================================
    match /customers/{uid} {
      // Users can only read and manage their own customer details
      allow read, write: if isOwner(uid);

      // --- Checkout Sessions Sub-collection ---
      match /checkout_sessions/{sessionId} {
        // Users can read their own checkout history
        allow read: if isOwner(uid);

        // Users can create checkout sessions with strict constraints
        allow create: if isOwner(uid) 
          && request.resource.data.productId != null 
          && request.resource.data.productId is string
          // Guard: Prohibit clients from injecting values that bypass triggers
          && !("amount" in request.resource.data) 
          && !("currency" in request.resource.data)
          && !("status" in request.resource.data)
          && !("order_id" in request.resource.data);

        // Clients are strictly forbidden from modifying active checkouts
        allow update, delete: if false;
      }

      // --- Subscriptions Sub-collection ---
      match /subscriptions/{subscriptionId} {
        // Users can read their own active subscription documents
        allow read: if isOwner(uid);

        // Users can trigger subscriptions with strict constraints
        allow create: if isOwner(uid)
          && request.resource.data.productId != null
          && request.resource.data.productId is string
          // Guard: Prohibit clients from injecting values that bypass triggers
          && !("plan_id" in request.resource.data)
          && !("status" in request.resource.data)
          && !("subscription_id" in request.resource.data)
          && !("firebaseRole" in request.resource.data);

        // Clients are strictly forbidden from modifying active subscriptions
        // Cancellation and plan upgrades are handled via admin secure callables
        allow update, delete: if false;

        // --- Subscription Transactional Payments ---
        match /payments/{paymentId} {
          allow read: if isOwner(uid);
          allow write: if false; // Only updated by server webhooks
        }
      }
    }

    // ==========================================
    // 🔒 Webhook Idempotency Collection
    // ==========================================
    match /webhook_events/{eventId} {
      // Clients have no reason to access webhook logs. Deny everything.
      allow read, write: if false;
    }
  }
}
```

---

## 🚀 How to Deploy Your Rules

To deploy these security rules:

1.  Save the rules inside the `firestore.rules` file in the root of your Firebase project directory.
2.  Deploy them using the Firebase CLI:

```bash
firebase deploy --only firestore:rules
```

3.  Alternatively, you can copy the code and paste it directly into the **Rules** tab of the Cloud Firestore section in the **Firebase Console** and click **Publish**.
