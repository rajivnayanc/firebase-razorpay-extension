import { handleSubscriptionEvent } from '../handlers/subscriptions';

const mockTransaction = {
    get: jest.fn(),
    set: jest.fn(),
};

jest.mock('firebase-admin', () => {
    const docMock = {
        get: jest.fn().mockResolvedValue({ exists: false }),
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis()
    };
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn(() => docMock),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn(mockTransaction)),
    };
    const authMock = {
        setCustomUserClaims: jest.fn().mockResolvedValue({}),
        getUser: jest.fn().mockResolvedValue({ customClaims: { 'premium': true } })
    };
    return {
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
        }),
        auth: jest.fn(() => authMock)
    };
});

describe('Webhook Handler: subscriptions (with Transactions)', () => {
    let mockAuth: any;

    beforeEach(() => {
        const admin = require('firebase-admin');
        mockAuth = admin.auth();
        jest.clearAllMocks();

        // Default: all transaction gets return non-existent docs
        mockTransaction.get.mockResolvedValue({ exists: false, data: () => null });
        const docMock = admin.firestore().doc();
        docMock.get.mockResolvedValue({ exists: false });
    });

    it('Behavior: should set custom claims on subscription.activated', async () => {
        let callCount = 0;
        mockTransaction.get.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ exists: false }); // dedup
            if (callCount === 2) return Promise.resolve({ exists: false, data: () => null }); // sub doc
            // Claims lock transaction gets
            return Promise.resolve({ exists: false, data: () => null });
        });

        const mockEvent = {
            id: 'evt_sub_act',
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: {
                        id: 'sub_123',
                        status: 'active',
                        notes: { uid: 'user_123', firebaseRole: 'premium' }
                    }
                }
            }
        };

        await handleSubscriptionEvent(mockEvent);

        // 2 sets from subscription transaction (sub doc + dedup) + 1 set from claims lock transaction
        expect(mockTransaction.set).toHaveBeenCalled();
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', { premium: true });
    });

    it('Behavior: should remove custom claims on subscription.cancelled', async () => {
        const admin = require('firebase-admin');
        const docMock = admin.firestore().doc();
        docMock.get.mockResolvedValueOnce({ exists: false }); // dedup
        docMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'active' }) }); // sub

        let callCount = 0;
        mockTransaction.get.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ exists: false }); // dedup
            if (callCount === 2) return Promise.resolve({ exists: true, data: () => ({ status: 'active' }) }); // active → cancelled
            // Claims lock transaction gets
            return Promise.resolve({ exists: false, data: () => null });
        });

        const mockEvent = {
            id: 'evt_sub_cancel',
            event: 'subscription.cancelled',
            payload: {
                subscription: {
                    entity: {
                        id: 'sub_123',
                        status: 'cancelled',
                        notes: { uid: 'user_123', firebaseRole: 'premium' }
                    }
                }
            }
        };

        await handleSubscriptionEvent(mockEvent);

        expect(mockAuth.getUser).toHaveBeenCalledWith('user_123');
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {});
    });

    it('Behavior: should SKIP duplicate subscription events', async () => {
        const admin = require('firebase-admin');
        const docMock = admin.firestore().doc();
        docMock.get.mockResolvedValue({ exists: true }); // dedup doc exists (outside transaction)

        mockTransaction.get.mockImplementation(() => {
            return Promise.resolve({ exists: true }); // dedup doc inside transaction
        });

        const mockEvent = {
            id: 'evt_sub_dup',
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: {
                        id: 'sub_123',
                        status: 'active',
                        notes: { uid: 'user_123', firebaseRole: 'premium' }
                    }
                }
            }
        };

        await handleSubscriptionEvent(mockEvent);

        expect(mockTransaction.set).not.toHaveBeenCalled();
        expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT reactivation of cancelled subscription', async () => {
        const admin = require('firebase-admin');
        const docMock = admin.firestore().doc();
        docMock.get.mockResolvedValueOnce({ exists: false }); // dedup
        docMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ status: 'cancelled' }) }); // sub (terminal!)

        let callCount = 0;
        mockTransaction.get.mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve({ exists: false }); // dedup
            return Promise.resolve({ exists: true, data: () => ({ status: 'cancelled' }) }); // TERMINAL
        });

        const mockEvent = {
            id: 'evt_sub_reactivate',
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: {
                        id: 'sub_123',
                        status: 'active',
                        notes: { uid: 'user_123', firebaseRole: 'premium' }
                    }
                }
            }
        };

        await handleSubscriptionEvent(mockEvent);

        expect(mockTransaction.set).not.toHaveBeenCalled();
        expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
    });
});
