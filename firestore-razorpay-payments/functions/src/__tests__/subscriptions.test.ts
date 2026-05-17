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
        mockAuth.getUser.mockResolvedValue({ customClaims: {} });
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

        const admin = require('firebase-admin');
        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(razorpayApi.subscriptions.fetch).toHaveBeenCalledWith('sub_123');
        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', { premium: true });
        
        const batch = admin.firestore().batch();
        expect(batch.set).toHaveBeenCalledTimes(1); // Writing sub doc
    });

    it('Behavior: should remove custom claims on subscription.cancelled', async () => {
        const admin = require('firebase-admin');
        const docMock = admin.firestore().doc();
        docMock.get.mockResolvedValueOnce({ empty: true, docs: [] });

        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { premium: true } });

        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'cancelled',
            notes: { uid: 'user_123', firebaseRole: 'premium' }
        });

        const mockEvent = {
            id: 'evt_sub_cancel',
            event: 'subscription.cancelled',
            payload: { subscription: { entity: { id: 'sub_123' } }, payment: null }
        };

        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(mockAuth.getUser).toHaveBeenCalledWith('user_123');
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

        const admin = require('firebase-admin');
        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);
        
        expect(razorpayApi.subscriptions.fetch).toHaveBeenCalledWith('sub_123');
        expect(razorpayApi.payments.fetch).toHaveBeenCalledWith('pay_001');

        // sub doc (batch.set) and payment subcollection doc (batch.set)
        const batch = admin.firestore().batch();
        expect(batch.set).toHaveBeenCalledTimes(2);
        expect(batch.set).toHaveBeenCalledWith(
            expect.anything(), 
            expect.objectContaining({ payment_id: 'pay_001' }),
            { merge: true }
        );
    });

    it('Behavior: should incrementally add claims (O(1) logic)', async () => {
        const admin = require('firebase-admin');
        
        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { premium: true } });

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

        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {
            premium: true,
            editor: true
        });
    });

    it('Behavior: should incrementally remove specific claim (O(1) logic)', async () => {
        const admin = require('firebase-admin');
        
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

        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {
            admin: true,
            editor: true
        });
    });
});
