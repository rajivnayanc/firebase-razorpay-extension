import {
    isValidSessionTransition,
    isValidSubscriptionTransition,
    isTerminalSessionStatus,
    isTerminalSubscriptionStatus
} from '../stateMachine';

describe('State Machine: Session Transitions', () => {
    it('Behavior: should allow null → processing', () => {
        expect(isValidSessionTransition(null, 'processing')).toBe(true);
        expect(isValidSessionTransition(undefined, 'processing')).toBe(true);
    });

    it('Behavior: should allow processing → created', () => {
        expect(isValidSessionTransition('processing', 'created')).toBe(true);
    });

    it('Behavior: should allow processing → failed', () => {
        expect(isValidSessionTransition('processing', 'failed')).toBe(true);
    });

    it('Behavior: should allow created → paid', () => {
        expect(isValidSessionTransition('created', 'paid')).toBe(true);
    });

    it('Behavior: should BLOCK paid → processing (terminal state attack)', () => {
        expect(isValidSessionTransition('paid', 'processing')).toBe(false);
    });

    it('Behavior: should BLOCK paid → failed (cannot revert completed payment)', () => {
        expect(isValidSessionTransition('paid', 'failed')).toBe(false);
    });

    it('Behavior: should BLOCK failed → paid (cannot resurrect failed payment)', () => {
        expect(isValidSessionTransition('failed', 'paid')).toBe(false);
    });

    it('Behavior: should allow null → paid (webhook can be first event)', () => {
        expect(isValidSessionTransition(null, 'paid')).toBe(true);
    });

    it('Behavior: should correctly identify terminal states', () => {
        expect(isTerminalSessionStatus('paid')).toBe(true);
        expect(isTerminalSessionStatus('failed')).toBe(true);
        expect(isTerminalSessionStatus('processing')).toBe(false);
        expect(isTerminalSessionStatus('created')).toBe(false);
        expect(isTerminalSessionStatus(null)).toBe(false);
    });
});

describe('State Machine: Subscription Transitions', () => {
    it('Behavior: should allow active → cancelled', () => {
        expect(isValidSubscriptionTransition('active', 'cancelled')).toBe(true);
    });

    it('Behavior: should allow active → halted', () => {
        expect(isValidSubscriptionTransition('active', 'halted')).toBe(true);
    });

    it('Behavior: should BLOCK cancelled → active (terminal state)', () => {
        expect(isValidSubscriptionTransition('cancelled', 'active')).toBe(false);
    });

    it('Behavior: should BLOCK halted → active (terminal state)', () => {
        expect(isValidSubscriptionTransition('halted', 'active')).toBe(false);
    });

    it('Behavior: should correctly identify terminal subscription states', () => {
        expect(isTerminalSubscriptionStatus('cancelled')).toBe(true);
        expect(isTerminalSubscriptionStatus('halted')).toBe(true);
        expect(isTerminalSubscriptionStatus('failed')).toBe(true);
        expect(isTerminalSubscriptionStatus('active')).toBe(false);
    });
});
