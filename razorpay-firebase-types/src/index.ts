export interface SanitizedPlan<TFieldValue = any, TTimestamp = any> {
  id: string;
  entity: string;
  interval: number;
  period: string;
  item: any | null; // Razorpay SDK item
  notes: Record<string, unknown>;
  active: boolean;
  created_at: number;
  updated_at: TFieldValue | TTimestamp;
  _synced_via: string;
}

export interface ProductDoc<TFieldValue = any, TTimestamp = any> {
  id: string;
  name: string;
  description?: string;
  active: boolean;
  type?: 'subscription' | 'one-time';
  amount?: number; // In subunits (paise) for one-time
  currency?: string; // For one-time
  planId?: string; // Link to plan when required (subscriptions)
  created_at?: TFieldValue | TTimestamp;
  updated_at?: TFieldValue | TTimestamp;
  _synced_via?: string;
}

export interface CreateProductRequest {
  id: string;
  name: string;
  description?: string;
  type: 'subscription' | 'one-time';
  amount?: number; // For one-time products (in subunits, e.g. paise)
  currency?: string; // For one-time products
  planId?: string; // Link to plan (subscriptions)
}

export interface CustomerDoc<TFieldValue = any, TTimestamp = any> {
  razorpay_customer_id: string;
  email: string | null;
  name?: string | null;
  phone?: string | null;
  created_at?: TFieldValue | TTimestamp;
  updated_at?: TFieldValue | TTimestamp;
}

export interface CheckoutSessionDoc<TFieldValue = any, TTimestamp = any> {
  // Input fields from client
  productId: string;
  metadata?: Record<string, string>;

  // Status & lock fields
  status?: 'processing' | 'created' | 'paid' | 'failed';
  processing_at?: TFieldValue | TTimestamp | null;
  error?: string;

  // Timestamps
  created_at?: TFieldValue | TTimestamp;
  updated_at?: TFieldValue | TTimestamp;
}

export interface SubscriptionDoc<TFieldValue = any, TTimestamp = any> {
  // Input fields from client
  productId: string;
  interval?: string;
  metadata?: Record<string, string>;
  draftId?: string;

  // Status & lock fields
  status?: string;
  processing_at?: TFieldValue | TTimestamp | null;
  error?: string;

  // Timestamps
  created_at?: TFieldValue | TTimestamp;
  updated_at?: TFieldValue | TTimestamp;
}

export interface WebhookEventDoc<TFieldValue = any, TTimestamp = any> {
  event: string;
  status: 'processing' | 'completed' | 'failed' | 'permanently_failed';
  created_at: TFieldValue | TTimestamp;
  updated_at: TFieldValue | TTimestamp;
  completed_at?: TFieldValue | TTimestamp;
  expireAt: Date;
}
