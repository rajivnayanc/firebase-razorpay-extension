import { handleSubscriptionEvent } from '../handlers/subscriptions';
import { getRazorpay } from '../api';



jest.mock('../api', () => {
    const fetchSubMock = jest.fn();
    const fetchPaymentMock = jest.fn();
    return {
        getRazorpay: jest.fn(() => ({
            subscriptions: { fetch: fetchSubMock },
            payments: { fetch: fetchPaymentMock }
        }))
    };
});

jest.mock('firebase-admin', () => {
    const docMock = {
        get: jest.fn().mockResolvedValue({ exists: false, empty: true, docs: [], data: () => null }),
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis()
    };
    const mockBatch = {
        set: jest.fn(),
        commit: jest.fn().mockResolvedValue({})
    };
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn(() => docMock),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        batch: jest.fn(() => mockBatch)
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

describe('Webhook Handler: subscriptions (with API as source of truth)', () => {
    let mockAuth: any;

    beforeEach(() => {
        const admin = require('firebase-admin');
        mockAuth = admin.auth();
        jest.clearAllMocks();
        // clear the shared batch mock
        admin.firestore().batch().set.mockClear();
        admin.firestore().batch().commit.mockClear();
        
        const docMock = admin.firestore().doc();
        docMock.get.mockResolvedValue({ exists: false, empty: true, docs: [], data: () => null });
    });

    it('Behavior: should set custom claims on subscription.activated', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'active',
            notes: { uid: 'user_123', firebaseRole: 'premium' }
        });



        const mockEvent = {
            id: 'evt_sub_act',
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: { id: 'sub_123' }
                },
                payment: null
            }
        };

        await handleSubscriptionEvent(mockEvent);

        expect(razorpayApi.subscriptions.fetch).toHaveBeenCalledWith('sub_123');
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', { premium: true });
        
        const admin = require('firebase-admin');
        const batch = admin.firestore().batch();
        expect(batch.set).toHaveBeenCalledTimes(1); // Writing sub doc
    });

    it('Behavior: should remove custom claims on subscription.cancelled', async () => {
        const admin = require('firebase-admin');
        const docMock = admin.firestore().doc();
        
        // Sequential .get() calls:
        // 1. subQuery (find sub doc by razorpay id)
        // 2. allSubs (syncCustomClaims fetching all for role derivation)
        docMock.get
            .mockResolvedValueOnce({ empty: true, docs: [] }) // subQuery: not found, falls back to using razorpay id as doc id
            .mockResolvedValueOnce({ 
                docs: [{ 
                    data: () => ({ 
                        status: 'cancelled', 
                        notes: { firebaseRole: 'premium' }
                    }) 
                }] 
            }); // syncCustomClaims: sees the cancelled sub

        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'cancelled',
            notes: { uid: 'user_123', firebaseRole: 'premium' }
        });

        const mockEvent = {
            id: 'evt_sub_cancel',
            event: 'subscription.cancelled',
            payload: {
                subscription: {
                    entity: { id: 'sub_123' }
                },
                payment: null
            }
        };

        await handleSubscriptionEvent(mockEvent);

        expect(mockAuth.getUser).toHaveBeenCalledWith('user_123');
        // Claims should be empty because the only sub is cancelled
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {});
    });



    it('Behavior: should handle subscription.charged events and record payments', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'active',
            notes: { uid: 'user_123' }
        });
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_001',
            amount: 1000
        });



        const mockEvent = {
            id: 'evt_charged_1',
            event: 'subscription.charged',
            payload: {
                subscription: { entity: { id: 'sub_123' } },
                payment: { entity: { id: 'pay_001' } }
            }
        };

        await handleSubscriptionEvent(mockEvent);
        
        expect(razorpayApi.subscriptions.fetch).toHaveBeenCalledWith('sub_123');
        expect(razorpayApi.payments.fetch).toHaveBeenCalledWith('pay_001');

        // sub doc (batch.set) and payment subcollection doc (batch.set)
        const admin = require('firebase-admin');
        const batch = admin.firestore().batch();
        expect(batch.set).toHaveBeenCalledTimes(2);
        expect(batch.set).toHaveBeenCalledWith(
            expect.anything(), 
            expect.objectContaining({ payment_id: 'pay_001' }),
            { merge: true }
        );
    });

    it('Behavior: should strictly derive claims resolving race conditions (syncCustomClaims)', async () => {
        const admin = require('firebase-admin');
        
        // Mock the subscriptions get() query to return two active subscriptions with different roles
        const mockSub1 = { data: () => ({ status: 'active', notes: { firebaseRole: 'premium' } }) };
        const mockSub2 = { data: () => ({ status: 'active', notes: { firebaseRole: 'editor' } }) };
        
        admin.firestore().doc().get
            .mockResolvedValueOnce({ empty: true, docs: [] }) // subQuery
            .mockResolvedValueOnce({ docs: [mockSub1, mockSub2] }); // allSubs

        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'active',
            notes: { uid: 'user_123', firebaseRole: 'editor' } // The webhook was just for 'editor'
        });

        const mockEvent = {
            id: 'evt_sub_act',
            event: 'subscription.activated',
            payload: { subscription: { entity: { id: 'sub_123' } }, payment: null }
        };

        await handleSubscriptionEvent(mockEvent);

        // Pre-existing non-subscription claims are kept, plus BOTH active roles are set.
        // We know from setup mockAuth.getUser returns { customClaims: { 'premium': true } }.
        // Actually, the new logic collects both 'premium' and 'editor' from the active docs,
        // and preserves 'premium' if it was already there (or derives it).
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {
            premium: true,
            editor: true
        });
    });

    it('Behavior: should only remove the specific claim when one of multiple subs is cancelled', async () => {
        const admin = require('firebase-admin');
        
        // Mock the subscriptions get() query: one cancelled, one active
        const mockSubCancelled = { data: () => ({ status: 'cancelled', notes: { firebaseRole: 'premium' } }) };
        const mockSubActive = { data: () => ({ status: 'active', notes: { firebaseRole: 'editor' } }) };
        
        admin.firestore().doc().get
            .mockResolvedValueOnce({ empty: true, docs: [] }) // subQuery
            .mockResolvedValueOnce({ docs: [mockSubCancelled, mockSubActive] }); // allSubs

        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { premium: true, editor: true, admin: true } });

        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'cancelled',
            notes: { uid: 'user_123', firebaseRole: 'premium' } // Webhook cancels premium
        });

        const mockEvent = {
            id: 'evt_sub_canc',
            event: 'subscription.cancelled',
            payload: { subscription: { entity: { id: 'sub_123' } }, payment: null }
        };

        await handleSubscriptionEvent(mockEvent);

        // 'admin' is preserved (non-subscription).
        // 'editor' is preserved (active subscription).
        // 'premium' is removed (no active subscriptions with it).
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {
            admin: true,
            editor: true
        });
    });
});
