import * as admin from 'firebase-admin';
import { QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { Orders } from 'razorpay/dist/types/orders';
import { Payments } from 'razorpay/dist/types/payments';
import { Subscriptions } from 'razorpay/dist/types/subscriptions';
import {
    RazorpaySyncConfig,
    CustomerDoc,
    ProductDoc,
    CheckoutSessionDoc,
    SubscriptionDoc,
    WebhookEventDoc,
    SanitizedPlan
} from '../types';

const converter = <T>() => ({
    toFirestore(model: T): admin.firestore.DocumentData {
        return model as admin.firestore.DocumentData;
    },
    fromFirestore(snapshot: QueryDocumentSnapshot): T {
        return snapshot.data() as T;
    }
});

export class TypedFirestore {
    constructor(private db: admin.firestore.Firestore, private config: RazorpaySyncConfig) {}

    getCustomersCollection() {
        return this.db.collection(this.config.customersCollection).withConverter(converter<CustomerDoc>());
    }

    getCustomerDoc(uid: string) {
        return this.getCustomersCollection().doc(uid);
    }

    getProductsCollection() {
        return this.db.collection(this.config.productsCollection).withConverter(converter<ProductDoc>());
    }

    getProductDoc(productId: string) {
        return this.getProductsCollection().doc(productId);
    }

    getPlansCollection() {
        return this.db.collection(this.config.plansCollection).withConverter(converter<SanitizedPlan>());
    }

    getPlanDoc(planId: string) {
        return this.getPlansCollection().doc(planId);
    }

    getCheckoutSessionsCollection(uid: string) {
        return this.getCustomerDoc(uid).collection('checkout_sessions').withConverter(converter<CheckoutSessionDoc>());
    }

    getCheckoutSessionDoc(uid: string, sessionId: string) {
        return this.getCheckoutSessionsCollection(uid).doc(sessionId);
    }

    getCheckoutSessionOrderDoc(uid: string, sessionId: string) {
        return this.getCheckoutSessionDoc(uid, sessionId)
            .collection('razorpay_responses')
            .doc('order')
            .withConverter(converter<Orders.RazorpayOrder>());
    }

    getCheckoutSessionPaymentDoc(uid: string, sessionId: string) {
        return this.getCheckoutSessionDoc(uid, sessionId)
            .collection('razorpay_responses')
            .doc('payment')
            .withConverter(converter<Payments.RazorpayPayment>());
    }

    getSubscriptionsCollection(uid: string) {
        return this.getCustomerDoc(uid).collection('subscriptions').withConverter(converter<SubscriptionDoc>());
    }

    getSubscriptionDoc(uid: string, subscriptionId: string) {
        return this.getSubscriptionsCollection(uid).doc(subscriptionId);
    }

    getSubscriptionDetailsDoc(uid: string, subscriptionId: string) {
        return this.getSubscriptionDoc(uid, subscriptionId)
            .collection('razorpay_responses')
            .doc('subscription')
            .withConverter(converter<Subscriptions.RazorpaySubscription>());
    }

    getSubscriptionPaymentsCollection(uid: string, subscriptionId: string) {
        return this.getSubscriptionDoc(uid, subscriptionId)
            .collection('payments')
            .withConverter(converter<Payments.RazorpayPayment>());
    }

    getSubscriptionPaymentDoc(uid: string, subscriptionId: string, paymentId: string) {
        return this.getSubscriptionPaymentsCollection(uid, subscriptionId).doc(paymentId);
    }

    getCustomerPaymentsCollection(uid: string) {
        return this.getCustomerDoc(uid).collection('payments').withConverter(converter<Payments.RazorpayPayment>());
    }

    getCustomerPaymentDoc(uid: string, paymentId: string) {
        return this.getCustomerPaymentsCollection(uid).doc(paymentId);
    }

    getCustomerOrdersCollection(uid: string) {
        return this.getCustomerDoc(uid).collection('orders').withConverter(converter<Orders.RazorpayOrder>());
    }

    getCustomerOrderDoc(uid: string, orderId: string) {
        return this.getCustomerOrdersCollection(uid).doc(orderId);
    }

    getWebhookEventsCollection() {
        return this.db.collection('webhook_events').withConverter(converter<WebhookEventDoc>());
    }

    getWebhookEventDoc(eventId: string) {
        return this.getWebhookEventsCollection().doc(eventId);
    }
}
