# Run Payments with Razorpay

This extension syncs Razorpay configuration (Products/Plans) and state (Payments/Subscriptions) to Cloud Firestore.

## Prerequisites

1.  **Razorpay Account**: You need a Razorpay account with your API keys (Key ID and Key Secret). We recommend creating [restricted keys](https://dashboard.razorpay.com/app/keys) with only the permissions your app needs.
2.  **Firestore Database**: You must have a Cloud Firestore database initialized in your Firebase project. [Create one here](https://firebase.google.com/docs/firestore/quickstart#create).
3.  **Firebase Authentication**: Required if you want to use role-based access control via custom claims based on subscription status. [Enable sign-in methods here](https://console.firebase.google.com/project/_/authentication/providers).

## Billing

This extension uses the following Firebase services which may have associated charges:

- **Cloud Firestore** — reads and writes for payment state, product catalogs, and deduplication records
- **Cloud Functions** — function invocations for Firestore triggers and webhook processing
- **Cloud Secret Manager** — secure storage and access for your Razorpay API keys
- **Firebase Authentication** — custom claims management for subscribers
- If you enable events, [Eventarc fees apply](https://cloud.google.com/eventarc/pricing).

This extension also uses the following third-party services:

- Razorpay Payments ([pricing information](https://razorpay.com/pricing))

You are responsible for any costs associated with your use of these services.

**Note from Firebase**: To install this extension, your Firebase project must be on the Blaze (pay-as-you-go) plan. You will only be charged for the resources you use. Most Firebase services offer a free tier for low-volume use. [Learn more about Firebase billing.](https://firebase.google.com/pricing)

## Preparing your setup

Before installing, decide on the paths for your Firestore collections:

- `CUSTOMERS_COLLECTION`: Default is `customers`. This is where customer documents and their `checkout_sessions` and `subscriptions` subcollections will be stored.
- `PRODUCTS_COLLECTION`: Default is `products`. Razorpay Items and Plans will be synced here via webhooks.

You will also need to generate a secure, random string to act as your Webhook Secret.
