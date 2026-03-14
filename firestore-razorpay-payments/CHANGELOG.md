## Version 1.0.0

Initial release of the _Run Payments with Razorpay_ extension.

### Features
- **One-time payments** via Razorpay Orders with Firestore-triggered checkout sessions
- **Recurring subscriptions** with automatic Razorpay Subscription creation
- **Real-time webhook sync** for payments, subscriptions, and product/plan updates
- **Idempotent processing** with Firestore Transactions, state machine enforcement, and event deduplication
- **Security**: Webhook signature verification, rate limiting, CORS restriction, error sanitization
- **Custom claims**: Automatic role-based access via Firebase Authentication
- **User lifecycle cleanup**: Cancels subscriptions and removes claims on user deletion
- **Eventarc integration**: Publishes custom events for extensibility
