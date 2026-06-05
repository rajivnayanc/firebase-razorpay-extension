export interface RazorpayUserConfig {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  customersCollection?: string;
  productsCollection?: string;
  syncCustomers?: boolean;
  syncCustomClaims?: boolean;
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
  syncCustomClaims: boolean;
  eventarcChannel?: string;
  allowedEventTypes?: string[];
}

export interface WebhookEvent {
  event: string;
  id: string;
  payload: any;
  created_at?: number;
}
