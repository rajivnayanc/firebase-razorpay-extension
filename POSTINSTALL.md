# Post-Installation Instructions

The "Run Payments with Razorpay" extension has been successfully installed!

## Action Required: Configure Webhooks

To ensure your Firestore database is synced correctly with Razorpay, you must configure a Webhook in the Razorpay Dashboard.

1. Go to your [Razorpay Dashboard -> Settings -> Webhooks](https://dashboard.razorpay.com/app/webhooks).
2. Click **Add New Webhook**.
3. Set the **Webhook URL** to the HTTP function created by this extension:
   `${function:razorpayWebhookHandler.url}`
4. Set the **Secret** to the exact Webhook Secret you entered during installation.
5. Select the following **Active Events**:
   - `order.paid`
   - `payment.captured`
   - `payment.failed`
   - `item.created`
   - `item.updated`
   - `item.deleted`
   - `plan.created`
   - `plan.updated`
   - `subscription.activated`
   - `subscription.charged`
   - `subscription.cancelled`
   - `subscription.updated`
6. Click **Save**.

Your extension is now ready to handle payments and subscriptions!
