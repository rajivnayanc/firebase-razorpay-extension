# @neocleus/razorpay-firebase-types

Shared TypeScript type definitions for the **Run Payments with Razorpay** Firebase Extension workspace.

This package contains type interfaces representing the Cloud Firestore document schemas, API request objects, and webhook payload structures.

---

## 📥 Installation

```bash
npm install @neocleus/razorpay-firebase-types
```

---

## 📋 Types & Interfaces

The package exports schema definitions parameterized by Firestore FieldValue and Timestamp types to ensure compatibility across both Admin SDK (server-side) and Client SDK contexts:

*   `SanitizedPlan<T_FieldValue, T_Timestamp>`: Represents plan catalog details.
*   `ProductDoc<T_FieldValue, T_Timestamp>`: Represents product details and allowed plans mapping.
*   `CustomerDoc<T_FieldValue, T_Timestamp>`: Contains the customer mapping (`razorpay_customer_id`) and metadata.
*   `CheckoutSessionDoc<T_FieldValue, T_Timestamp>`: Defines the schema for checkout sessions, including amounts, order details, and statuses.
*   `SubscriptionDoc<T_FieldValue, T_Timestamp>`: Defines the schema for subscription sessions and billing status.
*   `WebhookEventDoc<T_FieldValue, T_Timestamp>`: Represents internal webhook processing status logs.
