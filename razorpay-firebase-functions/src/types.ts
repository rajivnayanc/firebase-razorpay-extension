import * as admin from 'firebase-admin';
import * as Shared from '@neocleus/razorpay-firebase-types';

export type SanitizedPlan = Shared.SanitizedPlan<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type ProductDoc = Shared.ProductDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type CustomerDoc = Shared.CustomerDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type CheckoutSessionDoc = Shared.CheckoutSessionDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type SubscriptionDoc = Shared.SubscriptionDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;
export type WebhookEventDoc = Shared.WebhookEventDoc<admin.firestore.FieldValue, admin.firestore.Timestamp>;

export interface RazorpayUserConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  customersCollection?: string;
  productsCollection?: string;
  syncCustomers?: boolean;
  eventarcChannel?: string;
  allowedEventTypes?: string[];
}

export interface RazorpaySyncConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  customersCollection: string;
  productsCollection: string;
  syncCustomers: boolean;
  eventarcChannel?: string;
  allowedEventTypes?: string[];
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
