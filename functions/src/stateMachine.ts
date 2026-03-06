/**
 * Payment State Machine
 * 
 * Enforces strict, one-directional status transitions for checkout sessions
 * and subscriptions. Terminal states (paid, failed, cancelled) are immutable. 
 * This prevents webhook replay attacks from reverting completed payments.
 * 
 * State graph:
 *   null/undefined → processing → created → paid
 *                        ↓           ↓
 *                      failed      failed
 * 
 * Terminal states: paid, failed
 */

export type SessionStatus = 'processing' | 'created' | 'paid' | 'failed' | null | undefined;
export type SubscriptionStatus = 'processing' | 'created' | 'authenticated' | 'active' | 'charged' | 'cancelled' | 'halted' | 'failed' | null | undefined;

const VALID_SESSION_TRANSITIONS: Record<string, string[]> = {
    // Webhooks can be the first event for a session doc (before trigger creates it)
    '': ['processing', 'created', 'paid', 'failed'],
    'processing': ['created', 'paid', 'failed'],
    'created': ['paid', 'failed'],
    // Terminal states — NO outgoing transitions
    'paid': [],
    'failed': [],
};

const VALID_SUBSCRIPTION_TRANSITIONS: Record<string, string[]> = {
    // Webhooks can be the first event for a subscription doc (before trigger creates it)
    '': ['processing', 'created', 'authenticated', 'active', 'charged', 'cancelled', 'halted', 'failed'],
    'processing': ['created', 'authenticated', 'active', 'failed'],
    'created': ['authenticated', 'active', 'failed'],
    'authenticated': ['active', 'failed', 'cancelled', 'halted'],
    'active': ['charged', 'cancelled', 'halted', 'failed'],
    'charged': ['active', 'cancelled', 'halted', 'failed'],
    // Terminal states
    'cancelled': [],
    'halted': [],
    'failed': [],
};

export function isValidSessionTransition(from: SessionStatus, to: string): boolean {
    const fromKey = from || '';
    const allowed = VALID_SESSION_TRANSITIONS[fromKey];
    if (!allowed) return false;
    return allowed.includes(to);
}

export function isValidSubscriptionTransition(from: SubscriptionStatus, to: string): boolean {
    const fromKey = from || '';
    const allowed = VALID_SUBSCRIPTION_TRANSITIONS[fromKey];
    if (!allowed) return false;
    return allowed.includes(to);
}

export function isTerminalSessionStatus(status: SessionStatus): boolean {
    return status === 'paid' || status === 'failed';
}

export function isTerminalSubscriptionStatus(status: SubscriptionStatus): boolean {
    return status === 'cancelled' || status === 'halted' || status === 'failed';
}
