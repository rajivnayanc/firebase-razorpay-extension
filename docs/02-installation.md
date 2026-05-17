# 02. Installation & Local Emulator Setup

This guide provides step-by-step instructions for deploying the **Run Payments with Razorpay** extension to your Firebase project, configuring the necessary parameters, and running it locally inside the Firebase Emulator Suite for offline testing.

---

## 📋 Prerequisites

Before installing the extension, ensure you have:
1. A Firebase project on the **Blaze (Pay-as-you-go)** pricing plan. (Required by Firebase Extensions for running Node.js 22 runtimes and accessing Secret Manager).
2. A **Razorpay Account** (Sign up at [razorpay.com](https://razorpay.com)).
3. Retrieved your **API Key ID** and **Key Secret** from the [Razorpay Dashboard](https://dashboard.razorpay.com/app/keys) (either in **Test Mode** or **Live Mode**).

---

## 🚀 Custom & Manual Installation Methods

> [!IMPORTANT]
> **Firebase has stopped onboarding new publishers** to the public Extensions Hub. As a result, this extension must be manually added to your Firebase project.
>
> Additionally, **using the standard CLI installer command `firebase ext:install` only works with real Firebase projects** (requires billing enabled on Google Cloud). It will **FAIL** when trying to install directly into offline, local demo-only projects (such as `demo-test`).
>
> To circumvent this and configure the extension easily for **both real projects and demo-only projects**, you should **manually configure your `firebase.json` and local environment files**.

---

### 🛠️ Step 1: Manually Configure `firebase.json`

Open the `firebase.json` file in the root of your frontend application project directory and register the extension under the `extensions` block:

#### Option A: Direct Local Path (Best for Development & Cloned Repos)
Point the extension directly to your local cloned folder:
```json
{
  "extensions": {
    "razorpay-payments": "./firestore-razorpay-payments"
  }
}
```

#### Option B: GitHub Repository (Best for Remote/CI Deployments)
Point directly to the canonical GitHub repository (this downloads the source automatically during deployment/start):
```json
{
  "extensions": {
    "razorpay-payments": "rajivnayanc/firebase-razorpay-extension/firestore-razorpay-payments@1.0.0"
  }
}
```

---

### 📝 Step 2: Create Local Environment & Secret Files

To run the extension locally, you must separate **public configuration parameters** from **sensitive private credentials**. 

Create the following two files inside your application's `extensions/` directory:

#### 1️⃣ `extensions/razorpay-payments.env.local`
Contains public local parameters. It is safe to commit this file to your git repository:
```env
LOCATION=us-central1
CUSTOMERS_COLLECTION=customers
PRODUCTS_COLLECTION=products
SYNC_CUSTOMERS=true
SYNC_CUSTOM_CLAIMS=true
# Overrides Razorpay client base URL to let emulators run fully offline
# RAZORPAY_API_URL=http://localhost:9099
```

#### 2️⃣ `extensions/razorpay-payments.secret.local`
Contains sensitive local keys and secrets. **Add this file to your `.gitignore` immediately to prevent committing it to version control:**
```env
RAZORPAY_KEY_ID=rzp_test_mockkeyid12345
RAZORPAY_KEY_SECRET=mockkeysecret67890
RAZORPAY_WEBHOOK_SECRET=mockwebhooksecretabcde
```

---

### ⚡ Step 3: Run Locally or Deploy to Production

With the manual configuration files created, you can run the extension locally or migrate it to production.

#### A. Running Locally (Supports `demo-` Projects Offline)
You can start the Firebase Emulators using a **demo-only project** (e.g. `demo-test`) entirely offline! The emulator will automatically merge `razorpay-payments.env.local` and `razorpay-payments.secret.local` and run the triggers:
```bash
# Start your local emulator with a demo project identifier
firebase emulators:start --project=demo-test
```

#### B. Deploying to Production (Migrating Secrets to Google Cloud Secret Manager)

To deploy the custom manual extension to a live, billing-enabled Firebase project (Blaze plan), follow these steps:

1.  **Configure Public Production Variables**:
    Create a standard `extensions/razorpay-payments.env` file (without `.local` prefix) containing your public production parameters:
    ```env
    LOCATION=us-central1
    CUSTOMERS_COLLECTION=customers
    PRODUCTS_COLLECTION=products
    SYNC_CUSTOMERS=true
    SYNC_CUSTOM_CLAIMS=true
    ```
2.  **Run the Deploy Command**:
    Execute the extensions deploy command:
    ```bash
    firebase deploy --only extensions --project=YOUR_PRODUCTION_PROJECT_ID
    ```
3.  **Secure Terminal Prompts (Automatic Secret Manager Migration)**:
    Since parameters like `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` are flagged as **`Secret`** types in the extension schema and are **not** present in your public production `.env` file, **the Firebase CLI will securely prompt you in your terminal to input their live production values**.
    
    Upon inputting the secrets, the Firebase CLI automatically:
    *   Provisions three individual, secure secrets inside **Google Cloud Secret Manager**.
    *   Uploads your inputs directly to Secret Manager (they never touch your repository files).
    *   Automatically configures your deployed Cloud Functions triggers with the precise IAM service roles needed to decrypt and read these secrets at runtime.

> [!TIP]
> **Manual Secret Reference Option:**
> If you prefer to pre-create your production secrets manually in the Google Cloud Console's Secret Manager, you can skip the CLI prompts by specifying their Google Cloud Resource Names directly in your production `extensions/razorpay-payments.env` file:
> `RAZORPAY_KEY_ID=projects/YOUR_PROJECT_NUMBER/secrets/YOUR_SECRET_NAME/versions/latest`


---

## ⚙️ Parameter Reference

The following parameters are configured during installation:

| Parameter | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| **`LOCATION`** | Select | `us-central1` | The Google Cloud region where the Cloud Functions will deploy. For minimal latency, select a region closest to your Firestore database. |
| **`RAZORPAY_KEY_ID`** | Secret | *Required* | Your Razorpay API Key ID (e.g. `rzp_test_12345`). Stored securely in Google Cloud Secret Manager. |
| **`RAZORPAY_KEY_SECRET`** | Secret | *Required* | Your Razorpay API Key Secret. Stored securely in Google Cloud Secret Manager. |
| **`RAZORPAY_WEBHOOK_SECRET`** | Secret | *Required* | The secret key configured in the Razorpay Webhook Dashboard. Used to verify the HMAC-SHA256 signature of incoming webhooks. |
| **`CUSTOMERS_COLLECTION`** | String | `customers` | The collection path in Firestore where customer documents, checkout sessions, and subscriptions are stored. |
| **`PRODUCTS_COLLECTION`** | String | `products` | The collection path in Firestore where Razorpay Items and Plans will be synchronized. |
| **`SYNC_CUSTOMERS`** | Select | `true` | When `true`, automatically creates a Razorpay Customer when a Firebase Auth user is created. |
| **`SYNC_CUSTOM_CLAIMS`** | Select | `true` | When `true`, synchronizes custom claims (e.g., subscription roles) in Firebase Auth upon successful checkout. |
| **`RAZORPAY_API_URL`** | String | *Empty* | Used only for local emulator testing. Overrides the base URL of the Razorpay Client. |

---

## 🛠️ Local Development & Emulator Configuration

To test your payment and subscription integration locally without incurring live charges or hitting rate limits, you can run the extension inside the **Firebase Emulator Suite**.

### 1. Configure the Local Environment

Inside your local project's emulator configuration directory, add an extension environment file (e.g., `extensions/razorpay-payments.env`):

```env
LOCATION=us-central1
RAZORPAY_KEY_ID=rzp_test_mockkeyid12345
RAZORPAY_KEY_SECRET=mockkeysecret67890
RAZORPAY_WEBHOOK_SECRET=mockwebhooksecretabcde
CUSTOMERS_COLLECTION=customers
PRODUCTS_COLLECTION=products
SYNC_CUSTOMERS=true
SYNC_CUSTOM_CLAIMS=true
# Overrides Razorpay base client to point to a local mock server or mock webhook runner
RAZORPAY_API_URL=http://localhost:9099
```

> [!TIP]
> If you do not have a dedicated Razorpay Mock server running, you can use your actual Razorpay Test Key ID and Key Secret, and leave `RAZORPAY_API_URL` empty to let the local Cloud Functions make real HTTP calls to the Razorpay Test API while keeping the database and Auth triggers entirely simulated in the local emulators!

### 2. Start the Emulators

Start the Firebase Emulator Suite including Auth, Firestore, and Cloud Functions:

```bash
firebase emulators:start
```

Ensure the Functions output prints the loaded extension triggers:
*   `ext-razorpay-payments-createCustomer`
*   `ext-razorpay-payments-createOrder`
*   `ext-razorpay-payments-createSubscription`
*   `ext-razorpay-payments-razorpayWebhookHandler`

### 3. Testing Webhooks Locally

Since Razorpay's webhook engine requires a publicly accessible HTTPS endpoint, you cannot directly point Razorpay webhooks to `http://localhost:5001`.

To test webhook synchronization locally, you can use a tunneling tool like **ngrok** or **localtunnel**:

```bash
# Expose the local Cloud Functions port (usually 5001)
ngrok http 5001
```

1. Copy the forwarding URL generated by ngrok (e.g., `https://abcdef123.ngrok-free.app`).
2. Construct your local webhook endpoint:
   `https://abcdef123.ngrok-free.app/{YOUR_PROJECT_ID}/{LOCATION}/ext-razorpay-payments-razorpayWebhookHandler`
3. Configure this URL in the **Razorpay Dashboard** under settings, or send simulated payloads directly to it using a REST client like Postman or curl.

---

## ⚡ Next Steps

With the extension installed or simulated locally, proceed to **[03. Catalog & One-Time Payments](./03-one-time-payments.md)** to see how to define items, trigger checkouts, and handle payments.
