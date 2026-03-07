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
   - `item.created`, `item.updated`, `item.deleted`
   - `plan.created`, `plan.updated`
   - `subscription.activated`, `subscription.charged`, `subscription.cancelled`, `subscription.updated`
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

### Product & Plan sync

Products and Plans are automatically synced from Razorpay to the `${param:PRODUCTS_COLLECTION}` collection via webhooks.

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
| `com.razorpay.v1.subscription.activated` | Subscription activated |
| `com.razorpay.v1.subscription.cancelled` | Subscription cancelled |
| `com.razorpay.v1.item.created` | Product/Plan created |
| `com.razorpay.v1.item.updated` | Product/Plan updated |
| `com.razorpay.v1.item.deleted` | Product/Plan deleted |
