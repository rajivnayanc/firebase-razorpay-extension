import * as admin from 'firebase-admin';
import * as Shared from '@neocleus/razorpay-firebase-types';
import { Payments } from 'razorpay/dist/types/payments';
import { Subscriptions } from 'razorpay/dist/types/subscriptions';
import { HttpsOptions } from 'firebase-functions/v2/https';

export type SanitizedPlan = Shared.SanitizedPlan<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type ProductDoc = Shared.ProductDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type CustomerDoc = Shared.CustomerDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type CheckoutSessionDoc = Shared.CheckoutSessionDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type SubscriptionDoc = Shared.SubscriptionDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type WebhookEventDoc = Shared.WebhookEventDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type CreateProductRequest = Shared.CreateProductRequest;

export type OnCheckoutSessionUpdate = (
  uid: string,
  session: CheckoutSessionDoc,
  paymentDetails?: Payments.RazorpayPayment
) => Promise<void> | void;

export type OnSubscriptionUpdate = (
  uid: string,
  subscription: SubscriptionDoc,
  subscriptionDetails: Subscriptions.RazorpaySubscription
) => Promise<void> | void;

export interface RazorpayUserConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  customersCollection?: string;
  productsCollection?: string;
  plansCollection?: string;
  syncCustomers?: boolean;
  eventarcChannel?: string;
  allowedEventTypes?: string[];
  onCheckoutSessionUpdate?: OnCheckoutSessionUpdate;
  onSubscriptionUpdate?: OnSubscriptionUpdate;
  webhookOptions?: Omit<HttpsOptions, 'cors'>;
}

export interface RazorpaySyncConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  customersCollection: string;
  productsCollection: string;
  plansCollection: string;
  syncCustomers: boolean;
  eventarcChannel?: string;
  allowedEventTypes?: string[];
  onCheckoutSessionUpdate?: OnCheckoutSessionUpdate;
  onSubscriptionUpdate?: OnSubscriptionUpdate;
  webhookOptions?: Omit<HttpsOptions, 'cors'>;
}

export interface WebhookEntityWrapper {
  entity?: Record<string, any>;
  id?: string;
}

export interface WebhookPayload {
  payment?: WebhookEntityWrapper;
  order?: WebhookEntityWrapper;
  subscription?: WebhookEntityWrapper;
}

export interface WebhookEvent {
  event: string;
  id: string;
  payload: WebhookPayload;
  created_at?: number;
}
