# Run Payments with Razorpay

This extension syncs Razorpay configuration (Products/Plans) and state (Payments/Subscriptions) to Cloud Firestore.

## Prerequisites

1.  **Razorpay Account**: You need a Razorpay account with your API keys (Key ID and Key Secret).
2.  **Firestore Database**: You must have a Cloud Firestore database initialized in your Firebase project.
3.  **Firebase Authentication**: You must be using Firebase Authentication if you wish to leverage Custom User Claims based on subscription status.

## Billing Details

Installing this extension requires you to be on the Blaze (pay as you go) plan, as it deploys Cloud Functions.

## Preparing your setup

Before installing, decide on the paths for your Firestore collections:
- `CUSTOMERS_COLLECTION`: Default is `customers`. Example: `users`.
- `PRODUCTS_COLLECTION`: Default is `products`. Example: `plans`.

You will also need to generate a secure, random string to act as your Webhook Secret.
