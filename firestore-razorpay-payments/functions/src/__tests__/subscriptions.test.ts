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

jest.mock('../utils/customerMapping', () => ({
    getUidByCustomerId: jest.fn().mockResolvedValue('user_123')
}));


jest.mock('firebase-admin', () => {
    const getMock = jest.fn().mockResolvedValue({ exists: false, empty: true, docs: [], data: () => null });
    const setMock = jest.fn();
    const txMock = {
        get: getMock,
        set: setMock,
    };
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        runTransaction: jest.fn(async (fn: any) => fn(txMock)),
        _txMock: txMock,
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
        
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValue({ exists: true, data: () => ({ firebaseRole: 'premium', subscription_id: 'sub_123' }) });
        txMock.set.mockClear();

        mockAuth.getUser.mockResolvedValue({ customClaims: {} });
    });

    it('Behavior: should process subscription.activated and update Firestore', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'active',
            customer_id: 'cust_123',
            notes: { firebaseRole: 'premium' }
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
        
        const txMock = admin.firestore()._txMock;
        expect(txMock.set).toHaveBeenCalledTimes(1); // Writing sub doc
    });

    it('Behavior: should process subscription.cancelled and update Firestore status', async () => {
        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ firebaseRole: 'premium', subscription_id: 'sub_123' }) });

        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { premium: true } });

        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'cancelled',
            customer_id: 'cust_123',
            notes: { firebaseRole: 'premium' }
        });

        const mockEvent = {
            id: 'evt_sub_cancel',
            event: 'subscription.cancelled',
            payload: { subscription: { entity: { id: 'sub_123' } }, payment: null }
        };

        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(txMock.set).toHaveBeenCalledTimes(1);
    });



    it('Behavior: should handle subscription.charged events and record payments', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_123',
            status: 'active',
            customer_id: 'cust_123',
            notes: {}
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

        // sub doc and payment subcollection doc
        const txMock = admin.firestore()._txMock;
        expect(txMock.set).toHaveBeenCalledTimes(2);
        expect(txMock.set).toHaveBeenCalledWith(
            expect.anything(), 
            expect.objectContaining({ payment_id: 'pay_001' }),
            { merge: true }
        );
    });



    it('Security Behavior: should reject webhook and log error if subscription document does not exist', async () => {
        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: false, data: () => null });

        const razorpayApi = getRazorpay();
        (razorpayApi.subscriptions.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'sub_attacker',
            status: 'active',
            customer_id: 'cust_attacker',
            notes: { firebaseRole: 'admin' }
        });

        const mockEvent = {
            id: 'evt_sub_malicious',
            event: 'subscription.activated',
            payload: {
                subscription: {
                    entity: { id: 'sub_attacker' }
                },
                payment: null
            }
        };

        await handleSubscriptionEvent(mockEvent as any, admin.firestore(), razorpayApi);

        // Verify that Firestore write was skipped
        expect(txMock.set).not.toHaveBeenCalled();
    });
});
