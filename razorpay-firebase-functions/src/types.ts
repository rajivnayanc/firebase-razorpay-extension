import * as admin from 'firebase-admin';
import { Items } from 'razorpay/dist/types/items';

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

export interface SanitizedPlan {
  id: string;
  entity: string;
  interval: number;
  period: string;
  item: Items.RazorpayItem | null;
  notes: Record<string, unknown>;
  active: boolean;
  created_at: number;
  updated_at: admin.firestore.FieldValue | admin.firestore.Timestamp;
  _synced_via: string;
}

export interface ProductDoc {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  type?: 'subscription' | 'one-time';
  amount?: number; // In subunits (paise) for one-time
  currency?: string; // For one-time
  allowedPlans?: Record<string, string>; // planKey -> planId
  plans?: Record<string, SanitizedPlan>; // planKey -> SanitizedPlan
  created_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updated_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  _synced_via?: string;
}

export interface CustomerDoc {
  razorpay_customer_id: string;
  email: string | null;
  name?: string | null;
  phone?: string | null;
  created_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updated_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
}

export interface CheckoutSessionDoc {
  // Input fields from client
  productId: string;
  metadata?: Record<string, string>;

  // Status & lock fields
  status?: 'processing' | 'created' | 'paid' | 'failed';
  processing_at?: admin.firestore.FieldValue | admin.firestore.Timestamp | null;
  error?: string;

  // Timestamps
  created_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updated_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
}

export interface SubscriptionDoc {
  // Input fields from client
  productId: string;
  interval?: string;
  metadata?: Record<string, string>;
  draftId?: string;

  // Status & lock fields
  status?: string;
  processing_at?: admin.firestore.FieldValue | admin.firestore.Timestamp | null;
  error?: string;

  // Timestamps
  created_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updated_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
}

export interface WebhookEventDoc {
  event: string;
  status: 'processing' | 'completed' | 'failed' | 'permanently_failed';
  created_at: admin.firestore.FieldValue | admin.firestore.Timestamp;
  updated_at: admin.firestore.FieldValue | admin.firestore.Timestamp;
  completed_at?: admin.firestore.FieldValue | admin.firestore.Timestamp;
  expireAt: Date;
}
