import { handlePaymentEvent } from '../handlers/payments';

// Create a transaction mock that simulates Firestore transactions
const mockTransaction = {
    get: jest.fn(),
    set: jest.fn(),
};

jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn(mockTransaction)),
    };
    return {
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
        }),
    };
});

describe('Webhook Handler: payments (with Transactions)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Default: event doc doesn't exist yet, dedup doc doesn't exist
        mockTransaction.get.mockImplementation((ref: any) => {
            return Promise.resolve({ exists: false, data: () => null });
        });
    });

    it('Behavior: should update checkout session status to paid on payment.captured', async () => {
        // dedup doc: not exists; session doc: exists with status 'created'
        let callCount = 0;
        mockTransaction.get.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ exists: false }); // dedup
            return Promise.resolve({ exists: true, data: () => ({ status: 'created' }) }); // session
        });

        const mockEvent = {
            id: 'evt_001',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: { id: 'pay_123', notes: { uid: 'user_123', sessionId: 'session_123' } }
                }
            }
        };

        await handlePaymentEvent(mockEvent);

        expect(mockTransaction.set).toHaveBeenCalledTimes(2); // session + dedup
        expect(mockTransaction.set).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'paid', razorpay_payment_id: 'pay_123' }),
            { merge: true }
        );
    });

    it('Behavior: should SKIP duplicate events (idempotency)', async () => {
        // dedup doc exists → already processed
        let callCount = 0;
        mockTransaction.get.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ exists: true }); // dedup exists!
            return Promise.resolve({ exists: true, data: () => ({ status: 'created' }) });
        });

        const mockEvent = {
            id: 'evt_duplicate',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: { id: 'pay_123', notes: { uid: 'user_123', sessionId: 'session_123' } }
                }
            }
        };

        await handlePaymentEvent(mockEvent);

        // Transaction.set should NOT have been called — event was skipped
        expect(mockTransaction.set).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT state transition from paid → paid (terminal state)', async () => {
        let callCount = 0;
        mockTransaction.get.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ exists: false }); // dedup
            return Promise.resolve({ exists: true, data: () => ({ status: 'paid' }) }); // TERMINAL
        });

        const mockEvent = {
            id: 'evt_replay',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: { id: 'pay_123', notes: { uid: 'user_123', sessionId: 'session_123' } }
                }
            }
        };

        await handlePaymentEvent(mockEvent);

        // Should NOT write — terminal state is immutable
        expect(mockTransaction.set).not.toHaveBeenCalled();
    });

    it('Behavior: should ignore events with no mapping notes', async () => {
        const mockEvent = {
            id: 'evt_no_notes',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: { id: 'pay_123', notes: {} }
                }
            }
        };

        await handlePaymentEvent(mockEvent);
        expect(mockTransaction.set).not.toHaveBeenCalled();
    });
});
