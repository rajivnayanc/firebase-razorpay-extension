# Razorpay Firebase Extension — Sample App

A [Next.js](https://nextjs.org) app demonstrating the **firestore-razorpay-payments** Firebase Extension.

## Prerequisites

- [Node.js](https://nodejs.org/) ≥ 18
- [Firebase CLI](https://firebase.google.com/docs/cli) (`npm i -g firebase-tools`)
- Java Runtime ≥ 11 (required by Firebase Emulators)

## Setup

```bash
# 1. Install extension function dependencies
cd ../firestore-razorpay-payments/functions
npm install
npm run build
cd ../../sample-app

# 2. Install sample-app dependencies
npm install
```

## Running Locally

You need **two terminals**:

**Terminal 1 — Firebase Emulators** (from `sample-app/`):
```bash
firebase emulators:start --project demo-test
```

This starts Auth, Firestore, and Functions emulators and loads the Razorpay extension.

**Terminal 2 — Next.js Dev Server** (from `sample-app/`):
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

## How It Works

1. Click **Sign In Anonymously** — uses the Auth emulator.
2. Click **Pay ₹500.00** — creates a `checkout_sessions` doc in Firestore.
3. The extension's `createOrder` Cloud Function triggers and creates a Razorpay order.
4. The Razorpay checkout modal opens for the user to complete payment.

## Configuration

Extension parameters are in `extensions/razorpay-payments.env.local`. Update these with your Razorpay test keys for real API testing.
