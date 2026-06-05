import { FieldValue, Timestamp } from 'firebase/firestore';
import * as Shared from '@neocleus/razorpay-firebase-types';

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

export type SanitizedPlan = Shared.SanitizedPlan<FieldValue, Timestamp>;
export type ProductDoc = Shared.ProductDoc<FieldValue, Timestamp>;
export type CustomerDoc = Shared.CustomerDoc<FieldValue, Timestamp>;
export type CheckoutSessionDoc = Shared.CheckoutSessionDoc<FieldValue, Timestamp>;
export type SubscriptionDoc = Shared.SubscriptionDoc<FieldValue, Timestamp>;
