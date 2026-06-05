# @neocleus/razorpay-firebase-web-sdk

Client-side Web SDK for the **Run Payments with Razorpay** Firebase Extension.

This library handles Firestore document updates, listens to checkout statuses in real-time, and triggers the Razorpay Checkout overlay window in frontend applications.

---

## 📥 Installation

Install the package and its React peer dependencies:

```bash
npm install @neocleus/razorpay-firebase-web-sdk
```

---

## ⚙️ Quick Start

Initialize the checkout hook by passing your Firebase service instances and public key.

```typescript
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';
import { getFunctions } from 'firebase/functions';
import { useRazorpayPayments } from '@neocleus/razorpay-firebase-web-sdk';

const firestore = getFirestore();
const auth = getAuth();
const functions = getFunctions();

export function CheckoutComponent() {
  const { startCheckout, startSubscription } = useRazorpayPayments({
    firestore,
    auth,
    functions,
    keyId: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID || '', // Public Razorpay Key ID
    customersCollection: 'customers', // Optional, defaults to 'customers'
    productsCollection: 'products'    // Optional, defaults to 'products'
  });

  // Render logic...
}
```

---

## 🛒 Usage Examples

### 1. One-Time Checkout Flow: `startCheckout`

Create a checkout session doc for a product to trigger backend order generation. Once resolved, the SDK automatically opens the checkout popup modal.

```typescript
const buyProduct = async () => {
  try {
    const result = await startCheckout({
      productId: 'premium-ebook-pack',
      metadata: {
        promo: 'half_price_sale'
      },
      prefill: {
        name: 'John Doe',
        email: 'johndoe@example.com'
      },
      themeColor: '#1363DF'
    });

    if (result.status === 'paid') {
      alert('Payment confirmed! Access granted.');
    }
  } catch (error) {
    console.error('Checkout failed:', error);
  }
};
```

### 2. Recurring Subscriptions: `startSubscription`

Subscribe a user to a recurring product and billing interval.

```typescript
const subscribeToMembership = async () => {
  try {
    const result = await startSubscription({
      productId: 'premium-pro-membership',
      interval: 'monthly', // e.g. monthly, yearly
      prefill: {
        email: 'johndoe@example.com'
      }
    });

    if (result.status === 'active' || result.status === 'authenticated') {
      alert('Subscription active! Access unlocked.');
    }
  } catch (error) {
    console.error('Subscription setup failed:', error);
  }
};
```

---

## 🔒 Security Guidelines

*   **Public Key Only**: The `keyId` parameter is designed to be public and is exposed in client-side bundles. Only configure your public Razorpay Key ID here.
*   **No Fallbacks**: Never hardcode production/live key fallbacks (e.g. `keyId || 'rzp_test_xxxx'`). Load the variable dynamically via environment variables (such as `NEXT_PUBLIC_`) to avoid leaking keys to repository history.
