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

Write a document to the `${param:CUSTOMERS_COLLECTION}/{uid}/checkout_sessions` subcollection to create a Razorpay Order:

```javascript
const docRef = await firebase.firestore()
  .collection('${param:CUSTOMERS_COLLECTION}')
  .doc(userId)
  .collection('checkout_sessions')
  .add({
    amount: 50000,      // Amount in paise (₹500.00)
    currency: 'INR',
    receipt: `order_${Date.now()}`,
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
    plan_id: 'plan_XXXXXXXXXXXXX',
    total_count: 12,
  });
```

### Admin Plan Management

Since Razorpay doesn't have plan webhooks, you must use the following admin endpoints to manage your catalog. Only users with an `admin: true` or `role: 'admin'` custom claim can access these.

#### Setting Admin Claims
You can set admin claims using the Firebase Admin SDK or the Firebase CLI:
```javascript
// Using Node.js Admin SDK
admin.auth().setCustomUserClaims(uid, { admin: true, role: 'admin' });
```

---

#### `POST /admin/plans`
Creates a plan in Razorpay and Firestore.

#### `POST /admin/plans/sync`
Syncs all Razorpay plans to your Firestore products collection.

#### `GET /plans`
Public endpoint to fetch all synced plans for your UI.

Razorpay does not send webhook events for Products or Plans. You must use the extension's Admin endpoints to sync plans to your Firestore `${param:PRODUCTS_COLLECTION}` collection.

1. Give an admin user the `admin: true` Custom Claim in Firebase Auth.
2. Ensure you've acquired a Firebase ID Token for that user.
3. Call `POST /admin/plans/sync` to bulk-sync existing Razorpay plans to Firestore:
   ```bash
   curl -X POST ${function:razorpayWebhookHandler.url}/admin/plans/sync \
     -H "Authorization: Bearer <Firebase_ID_Token>"
   ```
4. Or, create a new plan via `POST /admin/plans`:
   ```bash
   curl -X POST ${function:razorpayWebhookHandler.url}/admin/plans \
     -H "Authorization: Bearer <Firebase_ID_Token>" \
     -H "Content-Type: application/json" \
     -d '{"period":"monthly","interval":1,"item":{"name":"Premium","amount":50000,"currency":"INR"}}'
   ```

You can then list all synced plans publicly for your users via the `GET /plans` endpoint.

### Role-based Access Control (Custom Claims)

You can automatically grant Firebase Auth custom claims to users when they subscribe to specific plans.

1. Open your Razorpay Dashboard and navigate to your **Plans**.
2. Add a new **Note** to the Plan. Set the key to `firebaseRole` and the value to the custom claim you want applied (e.g., `admin` or `premium`).
3. The extension will automatically set and remove this claim as the subscription lifecycle changes (activated, cancelled, etc.).

> **Security Note:** Custom claims are fetched from Razorpay directly to prevent privilege escalation. Do not pass the `firebaseRole` field from the client.

## Verify a Payment

Use the verify endpoint to confirm payment authenticity:

```
POST ${function:razorpayWebhookHandler.url}/verify-payment
Authorization: Bearer <Firebase ID Token>
Content-Type: application/json

{
  "razorpay_order_id": "order_xxx",
  "razorpay_payment_id": "pay_xxx",
  "razorpay_signature": "xxx"
}
```

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
