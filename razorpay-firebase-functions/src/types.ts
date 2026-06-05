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
