# Testing the Razorpay Extension

This guide covers how to rigorously test the Razorpay extension using Firebase Emulators and `ngrok`.

## 1. Automated Integration Tests (Local)

To run the integration suite locally, which spins up a mock Firestore environment and checks the triggers:
```bash
cd functions
npm run test
```

## 2. Manual End-to-End Testing (Firebase Emulator + Ngrok)

To truly verify the webhook handlers behave perfectly with the actual Razorpay API, you should connect your local Firebase Emulator environment to Razorpay's test webhooks.

### Step 2.1: Start the Emulators
In the root directory, start the emulators for Functions, Firestore, and Auth:
```bash
firebase emulators:start --only functions,firestore,auth
```
- Note the port your `razorpayWebhookHandler` function is running on (usually `http://127.0.0.1:5001/YOUR_PROJECT/us-central1/razorpayWebhookHandler`).

### Step 2.2: Expose via Ngrok
Run `ngrok` to expose that local port to the internet.
```bash
ngrok http 5001
```
Ngrok will give you an `https://...` URL.

### Step 2.3: Configure Razorpay Test Dashboard
1. Log into your Razorpay Dashboard and switch to **Test Mode**.
2. Go to Settings -> Webhooks -> Add New Webhook.
3. Paste the Ngrok URL appended with the function path: `https://<random-ngrok-id>.ngrok-free.app/YOUR_PROJECT/us-central1/razorpayWebhookHandler`.
4. Enter your chosen Webhook Secret.
5. Select all the active events you want to test (e.g., `payment.captured`, `subscription.activated`).

### Step 2.4: Test the Flow
1. Open the **Firebase Emulator UI** (usually `http://localhost:4000`).
2. Go to **Firestore**.
3. Create a collection: `customers`. Add a document with ID `tester1`.
4. Inside `tester1`, create a subcollection `checkout_sessions`. Add a doc with:
   - `amount`: `50000` (500 INR in paise)
   - `currency`: `INR`
5. Watch the emulator terminal: You should see the `createOrder` trigger run, call Razorpay, and update the document with an `order_id`.
6. Now, simulate a webhook trigger from the Razorpay dashboard, or use Postman to ping your local endpoint directly to mimic a successful payment.
7. Verify in the Emulator UI that the checkout session status updates to `paid`. 
