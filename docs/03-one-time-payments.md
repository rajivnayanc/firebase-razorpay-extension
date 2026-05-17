# 03. Catalog & One-Time Payments

This guide details how to build secure, catalog-driven one-time checkout flows. It covers setting up your Firestore product catalog, writing checkout triggers, and integrating the client-side Razorpay Checkout SDK.

---

## 📦 1. Product Catalog Setup

To prevent clients from tampering with pricing (e.g. setting a ₹5,000 product to ₹1 via browser dev tools), this extension uses a **catalog-driven pricing model**. All product metadata, pricing, and currencies are securely fetched from a read-only Firestore collection.

Create a product document in the collection defined by your `PRODUCTS_COLLECTION` parameter (e.g., `/products`):

### 📄 Firestore Product Document Schema
*   **Path**: `/products/{productId}`
*   **Document ID**: A descriptive, unique slug (e.g., `premium-ebook-pack`)

```json
{
  "name": "Premium eBook Pack",
  "description": "Access to all 10 developer reference guides.",
  "amount": 49900, // Integer in the smallest currency unit (e.g. 49900 paise = ₹499.00)
  "currency": "INR", // 3-letter ISO code
  "active": true
}
```

> [!WARNING]
> The `amount` field must always represent the smallest unit of currency. For `INR`, this is paise (1 Rupee = 100 paise). For `USD`, this is cents (1 Dollar = 100 cents).

---

## 🛒 2. Triggering Checkout Sessions

To initiate a purchase, your client-side application writes a new document to the user's `checkout_sessions` subcollection.

### 📄 Firestore Checkout Session Write Schema
*   **Path**: `/customers/{uid}/checkout_sessions/{sessionId}`
*   **Document ID**: A dynamically generated UUID/v4 ID.
*   **Client Permitted Fields**: Must **ONLY** write the `productId`.

```json
{
  "productId": "premium-ebook-pack"
}
```

### 🔒 Server-Side Validation Guards

When a new checkout session document is written, the `createOrder` Cloud Function is triggered. It performs rigorous security and state validation:

1.  **Direct Amount Guard**: If the client attempts to write an `amount` property in the checkout document, the function immediately terminates, updates the document status to `failed`, and logs a security violation:
    `Providing amount directly is not allowed. Provide a productId instead.`
2.  **Product Verification**: The function fetches the product document from the secure `/products` collection. If the product does not exist, or does not have a valid positive amount, it marks the status as `failed`.
3.  **Concurrency Lock**: Using a Firestore transaction, the document is locked under `status: 'processing'` with a `processing_at` timestamp. This prevents double execution if multiple triggers fire.
4.  **Lazy Customer Sync**: If the customer document doesn't have a `razorpay_customer_id`, the function lazily calls Razorpay's API to register the user, saving their Customer ID back to the Firestore customer document.

---

## 🛡️ 3. Receipt-Based Duplicate Check

In distributed networks, cloud triggers can fire multiple times, or client retries can create duplicate order records. To guarantee absolute idempotency, the extension uses **receipt-based duplicate checks** against Razorpay's API:

```typescript
// Truncates checkout session ID to fit Razorpay's 40-character receipt limit
const receipt = sessionId.substring(0, 40);

// Look up existing orders under this receipt
const existingOrders = await razorpay.orders.all({ receipt });
const matchingOrder = existingOrders?.items?.find(
  (o) => o.receipt === receipt && o.status === 'created'
);

if (matchingOrder) {
  // Reuse existing Razorpay order ID to prevent double payments
  order = matchingOrder;
} else {
  // Create a brand new order securely
  order = await razorpay.orders.create({ amount, currency, receipt, notes });
}
```

Once resolved, the function updates the Firestore checkout session document with the Razorpay order details:

```json
{
  "order_id": "order_Nabc123Xyz",
  "amount": 49900,
  "amount_paid": 0,
  "amount_due": 49900,
  "currency": "INR",
  "receipt": "checkout_session_doc_id_40_chars",
  "status": "created",
  "created_at": "server_timestamp"
}
```

---

## 💻 4. Client-Side Integration Example

Once the checkout session is updated by the extension with an `order_id`, the client application extracts it and launches the Razorpay Checkout dialog.

Here is a full Javascript example:

```javascript
import { getFirestore, collection, doc, addDoc, onSnapshot } from "firebase/firestore";

const db = getFirestore();
const userId = "firebase-auth-user-uid";

async function startOneTimeCheckout(productId) {
  // 1. Write the session doc to trigger the Cloud Function
  const sessionRef = await addDoc(
    collection(db, "customers", userId, "checkout_sessions"), 
    { productId: productId }
  );

  // 2. Listen to document changes waiting for order_id to be populated
  const unsubscribe = onSnapshot(sessionRef, (snapshot) => {
    const data = snapshot.data();
    
    if (data.status === "failed") {
      console.error("Order creation failed:", data.error);
      unsubscribe();
      return;
    }
    
    if (data.status === "created" && data.order_id) {
      unsubscribe(); // Stop listening
      
      // 3. Open the Razorpay Checkout Modal
      const options = {
        key: "YOUR_RAZORPAY_KEY_ID", // Input your client-facing Razorpay Key ID
        amount: data.amount,
        currency: data.currency,
        name: "My App Name",
        description: "Buying Premium eBook Pack",
        order_id: data.order_id,
        handler: function (response) {
          // Razorpay returns authorization details
          console.log("Payment authorized successfully!", response);
          
          alert("Payment processed! Awaiting confirmation...");
          // The webhook will automatically capture the payment and update the status to 'paid'
        },
        prefill: {
          name: "John Doe",
          email: "johndoe@example.com"
        },
        theme: {
          color: "#3399cc"
        }
      };
      
      const rzp = new window.Razorpay(options);
      rzp.open();
    }
  });
}
```

---

## 🔄 5. Payment Capture and Sync

After the user inputs their payment details:
1. Razorpay processes the charge and emits a webhook event `payment.captured` or `order.paid`.
2. The extension's HTTPS endpoint `razorpayWebhookHandler` intercepts this payload, verifies the signature, and updates the checkout session status in Firestore:

```json
{
  "status": "paid",
  "amount_paid": 49900,
  "amount_due": 0,
  "razorpay_payment_id": "pay_Mxyz789Abc",
  "method": "upi",
  "updated_at": "server_timestamp"
}
```

Your client UI (listening to the checkout session document) will immediately detect `status === 'paid'` and can instantly unlock the digital assets.

---

## ⚡ Next Steps

For applications offering recurring services or memberships, proceed to **[04. Plan Sync & Subscriptions](./04-subscriptions.md)** to configure recurring plans and custom roles.
