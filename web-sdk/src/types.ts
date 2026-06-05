import { FieldValue, Timestamp } from 'firebase/firestore';

export interface RazorpayPopupResponse {
  razorpay_payment_id: string;
  razorpay_order_id?: string;
  razorpay_signature: string;
  razorpay_subscription_id?: string;
}

export interface RazorpayPopupOptions {
  key: string;
  amount?: number;
  currency?: string;
  name?: string;
  description?: string;
  image?: string;
  order_id?: string;
  subscription_id?: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
  handler?: (response: RazorpayPopupResponse) => void;
  modal?: {
    ondismiss?: () => void;
    escape?: boolean;
    handleback?: boolean;
  };
}

export interface SanitizedPlan {
  id: string;
  entity: string;
  interval: number;
  period: string;
  item: any; // Razorpay item details
  notes: Record<string, unknown>;
  active: boolean;
  created_at: number;
  updated_at: FieldValue | Timestamp;
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
  created_at?: FieldValue | Timestamp;
  updated_at?: FieldValue | Timestamp;
  _synced_via?: string;
}

export interface CustomerDoc {
  razorpay_customer_id: string;
  email: string | null;
  name?: string | null;
  phone?: string | null;
  created_at?: FieldValue | Timestamp;
  updated_at?: FieldValue | Timestamp;
}

export interface CheckoutSessionDoc {
  productId: string;
  metadata?: Record<string, string>;
  status?: 'processing' | 'created' | 'paid' | 'failed';
  processing_at?: FieldValue | Timestamp | null;
  error?: string;
  created_at?: FieldValue | Timestamp;
  updated_at?: FieldValue | Timestamp;
}

export interface SubscriptionDoc {
  productId: string;
  interval?: string;
  metadata?: Record<string, string>;
  draftId?: string;
  status?: string;
  processing_at?: FieldValue | Timestamp | null;
  error?: string;
  created_at?: FieldValue | Timestamp;
  updated_at?: FieldValue | Timestamp;
}
