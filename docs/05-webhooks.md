# 05. Webhook Configurations & Event Mappings

Incoming webhooks are the primary synchronization engine of this extension. They ensure that payment captures, cancellations, updates, and refunds are pushed into your Firestore database in real-time.

---

## ⚙️ 1. Configuring Razorpay Webhooks

To configure webhooks in your Razorpay Dashboard:

1.  Navigate to the **Razorpay Dashboard** -> **Settings** -> **Webhooks**.
2.  Click **+ Add New Webhook**.
3.  Set the **Webhook URL**:
    *   **Production**: `https://{LOCATION}-{PROJECT_ID}.cloudfunctions.net/ext-razorpay-payments-razorpayWebhookHandler`
    *   **Local Emulator**: Use your forwarding ngrok URL (see **[02. Emulator Setup](./02-installation.md)**).
4.  Input a secure **Webhook Secret**. Copy this secret exactly and set it as your `RAZORPAY_WEBHOOK_SECRET` extension parameter.
5.  Select the following **Active Events**:

| Event Category | Active Webhook Events to Select |
| :--- | :--- |
| **Payments** | `payment.captured`, `payment.failed`, `payment.authorized` |
| **Orders** | `order.paid` |
| **Subscriptions** | `subscription.activated`, `subscription.authenticated`, `subscription.charged`, `subscription.updated`, `subscription.paused`, `subscription.resumed`, `subscription.cancelled`, `subscription.completed`, `subscription.pending`, `subscription.halted` |

---

## 🔒 2. Webhook Signature Validation

To protect your system from spoofing attacks, the extension validates the signature of every incoming POST request before executing any database updates.

Using the raw request body buffer and the secret configured in Secret Manager, the extension computes a cryptographic HMAC-SHA256 signature and compares it with the `x-razorpay-signature` header:

```typescript
import * as crypto from 'crypto';

export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
    const expectedSignature = crypto
        .createHmac('sha256', razorpayWebhookSecret)
        .update(rawBody)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(signature, 'utf8'),
        Buffer.from(expectedSignature, 'utf8')
    );
}
```

If signature verification fails, the extension immediately halts execution and returns a `401 Unauthorized` response to Razorpay.

---

## 📋 3. Webhook-to-Firestore Mapping

When an event passes signature verification, the handler parses the entity payload and updates the appropriate Firestore collection:

| Webhook Event | Affected Firestore Path | Action / Fields Synchronized |
| :--- | :--- | :--- |
| `order.paid` | `customers/{uid}/checkout_sessions/{id}` | Updates status to `paid`, synchronizes `amount_paid` and `amount_due`. |
| `payment.captured` | `customers/{uid}/checkout_sessions/{id}` | Updates status to `paid`, adds `razorpay_payment_id`, `method`, `currency`, and `amount`. |
| `payment.failed` | `customers/{uid}/checkout_sessions/{id}` | Updates status to `failed` and logs error message. |
| `subscription.activated` | `customers/{uid}/subscriptions/{id}` | Sets status to `active`, updates `current_start`, `current_end`, `paid_count`, `charge_at`. |
| `subscription.authenticated` | `customers/{uid}/subscriptions/{id}` | Sets status to `authenticated`. |
| `subscription.paused` | `customers/{uid}/subscriptions/{id}` | Sets status to `paused`. User's claims are removed. |
| `subscription.resumed` | `customers/{uid}/subscriptions/{id}` | Sets status to `active`. User's claims are restored. |
| `subscription.cancelled` | `customers/{uid}/subscriptions/{id}` | Sets status to `cancelled`. User's claims are deleted. |
| `subscription.completed` | `customers/{uid}/subscriptions/{id}` | Sets status to `completed`. User's claims are deleted. |
| `subscription.halted` | `customers/{uid}/subscriptions/{id}` | Sets status to `halted`. User's claims are deleted. |

---

## 🧾 4. Recording Subscription Payments

When a subscription is charged recurringly (indicated by `subscription.charged` or subscription events containing a payment payload), the extension automatically tracks the individual transaction logs under a subcollection inside the subscription document.

*   **Subcollection Path**: `/customers/{uid}/subscriptions/{subscriptionId}/payments/{paymentId}`

This allows you to construct billing statements or payment history views inside your app:

```json
{
  "payment_id": "pay_Scharged12345",
  "amount": 99900,
  "currency": "INR",
  "status": "captured",
  "method": "card",
  "order_id": "order_Subcharge999",
  "updated_at": "server_timestamp"
}
```

---

## 🛡️ 5. Role-Based Access Control Custom Claims Sync

When a subscription's status changes, the extension automatically manages access control using **Firebase Auth Custom Claims**.

```mermaid
stateGraphic
    [*] --> created
    created --> active : Webhook Sync
    active --> GrantClaims : role added
    active --> paused/cancelled : Webhook Sync
    paused/cancelled --> RevokeClaims : role deleted
```

### 🔒 Secure Claim Resolution

To prevent malicious users from spoofing claims or hijacking premium subscription tiers, the extension:
1.  **Ignores** any roles or claims sent in the webhook payload notes.
2.  Fetches the existing, trusted subscription document from Firestore (originally written securely by `createSubscription` trigger from `/products` collection).
3.  Determines whether the role is active:
    *   **Grant Role**: Status is `active` or `authenticated`.
    *   **Revoke Role**: Status is `cancelled`, `halted`, `paused`, or `completed`.
4.  Saves claims atomically without losing other pre-existing claims on the user record.

---

## 📢 6. Eventarc Integration

For developers needing to execute downstream operations (e.g. sending a confirmation email via Postmark, updating a marketing ledger, or provisioning microservices), the extension emits custom events to Google Cloud **Eventarc**.

If configured, every verified webhook triggers an Eventarc event with the type:
`com.razorpay.v1.{event_name}`

You can easily deploy a custom subscriber function listening to this event type to run secondary tasks entirely decoupled from the payment extensions engine.

---

## ⚡ Next Steps

Proceed to **[06. Idempotency & Fault-Tolerance](./06-idempotency.md)** to understand how the extension prevents replay attacks, trigger loops, and double charges.
