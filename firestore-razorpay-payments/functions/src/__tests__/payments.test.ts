import { handlePaymentEvent } from '../handlers/payments';
import { getRazorpay } from '../api';



jest.mock('../api', () => {
    const fetchPaymentMock = jest.fn();
    const fetchOrderMock = jest.fn();
    return {
        getRazorpay: jest.fn(() => ({
            payments: { fetch: fetchPaymentMock },
            orders: { fetch: fetchOrderMock }
        }))
    };
});

jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
    };
    return {
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
        }),
    };
});

describe('Webhook Handler: payments (with API as source of truth)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('Behavior: should update checkout session status to paid on payment.captured', async () => {

        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_123',
            status: 'captured',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_001',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: { id: 'pay_123' }
                }
            }
        };

        await handlePaymentEvent(mockEvent);

        const admin = require('firebase-admin');
        const firestoreMock = admin.firestore();

        expect(razorpayApi.payments.fetch).toHaveBeenCalledWith('pay_123');
        expect(firestoreMock.set).toHaveBeenCalledTimes(1);
        expect(firestoreMock.set).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'paid', razorpay_payment_id: 'pay_123' }),
            { merge: true }
        );
    });

    it('Behavior: should ignore events with no mapping notes', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_123',
            status: 'captured',
            notes: {} // missing uid and sessionId
        });

        const mockEvent = {
            id: 'evt_no_notes',
            event: 'payment.captured',
            payload: {
                payment: {
                    entity: { id: 'pay_123' }
                }
            }
        };

        await handlePaymentEvent(mockEvent);
        const admin = require('firebase-admin');
        expect(admin.firestore().set).not.toHaveBeenCalled();
    });

    it('Behavior: should return early if both payment and order IDs are missing', async () => {
        const mockEvent = {
            id: 'evt_missing_ids',
            event: 'payment.captured',
            payload: { payment: {}, order: {} }
        };

        await handlePaymentEvent(mockEvent as any);
        const admin = require('firebase-admin');
        expect(admin.firestore().set).not.toHaveBeenCalled();
    });

    it('Behavior: should handle failure to fetch entity from Razorpay API', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockRejectedValueOnce(new Error('API Error'));

        const mockEvent = {
            id: 'evt_api_fail',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_123' } } }
        };

        await handlePaymentEvent(mockEvent as any);
        const admin = require('firebase-admin');
        expect(admin.firestore().set).not.toHaveBeenCalled();
    });

    it('Behavior: should handle entity resolution failure (null returned)', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce(null);

        const mockEvent = {
            id: 'evt_null_entity',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_123' } } }
        };

        await handlePaymentEvent(mockEvent as any);
        const admin = require('firebase-admin');
        expect(admin.firestore().set).not.toHaveBeenCalled();
    });

    it('Behavior: should map payment status failed to failed', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_fail',
            status: 'failed',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_fail',
            event: 'payment.failed',
            payload: { payment: { entity: { id: 'pay_fail' } } }
        };

        await handlePaymentEvent(mockEvent as any);
        const admin = require('firebase-admin');
        expect(admin.firestore().set).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed' }),
            { merge: true }
        );
    });

    it('Behavior: should resolve via order ID and map status paid to paid', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.orders.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'order_paid',
            status: 'paid',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_order_paid',
            event: 'order.paid',
            payload: { order: { entity: { id: 'order_paid' } } }
        };

        await handlePaymentEvent(mockEvent as any);
        const admin = require('firebase-admin');
        expect(admin.firestore().set).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'paid', order_id: 'order_paid' }),
            { merge: true }
        );
    });
});
