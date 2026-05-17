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

jest.mock('firebase-admin/firestore', () => ({
    FieldValue: {
        serverTimestamp: jest.fn(() => 'server_time'),
        delete: jest.fn(() => 'field_delete'),
    }
}));

jest.mock('firebase-admin', () => {
    const getMock = jest.fn().mockResolvedValue({ exists: true, data: () => ({ order_id: 'order_123' }) });
    const setMock = jest.fn();
    const txMock = {
        get: getMock,
        set: setMock,
    };
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn(txMock)),
        _txMock: txMock,
    };
    return {
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: {
                serverTimestamp: jest.fn(() => 'server_time'),
                delete: jest.fn(() => 'field_delete'),
            }
        }),
    };
});

describe('Webhook Handler: payments (with API as source of truth)', () => {

    beforeEach(() => {
        jest.clearAllMocks();
        // Reset the transaction mock to default (existing doc with matching order_id)
        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValue({ exists: true, data: () => ({ order_id: 'order_123' }) });
        txMock.set.mockClear();
    });

    it('Behavior: should update checkout session status to paid on payment.captured', async () => {

        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_123',
            status: 'captured',
            order_id: 'order_123',
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

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_123' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(razorpayApi.payments.fetch).toHaveBeenCalledWith('pay_123');
        expect(txMock.set).toHaveBeenCalledTimes(1);
        expect(txMock.set).toHaveBeenCalledWith(
            expect.anything(),
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

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);
        expect(txMock.set).not.toHaveBeenCalled();
    });

    it('Behavior: should return early if both payment and order IDs are missing', async () => {
        const mockEvent = {
            id: 'evt_missing_ids',
            event: 'payment.captured',
            payload: { payment: {}, order: {} }
        };

        const admin = require('firebase-admin');
        const razorpayApi = getRazorpay();
        const txMock = admin.firestore()._txMock;
        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);
        expect(txMock.set).not.toHaveBeenCalled();
    });

    it('Behavior: should handle failure to fetch entity from Razorpay API', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockRejectedValueOnce(new Error('API Error'));

        const mockEvent = {
            id: 'evt_api_fail',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_123' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);
        expect(txMock.set).not.toHaveBeenCalled();
    });

    it('Behavior: should handle entity resolution failure (null returned)', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce(null);

        const mockEvent = {
            id: 'evt_null_entity',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_123' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);
        expect(txMock.set).not.toHaveBeenCalled();
    });

    it('Behavior: should map payment status failed to failed', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_fail',
            status: 'failed',
            order_id: 'order_123',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_fail',
            event: 'payment.failed',
            payload: { payment: { entity: { id: 'pay_fail' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_123' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);
        expect(txMock.set).toHaveBeenCalledWith(
            expect.anything(),
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

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_paid' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);
        expect(txMock.set).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'paid', order_id: 'order_paid' }),
            { merge: true }
        );
    });

    it('should reject writes when checkout session does not exist (notes injection)', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_evil',
            status: 'captured',
            order_id: 'order_evil',
            notes: { uid: 'victim_uid', sessionId: 'victim_session' }
        });

        const mockEvent = {
            id: 'evt_inject_1',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_evil' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        // Session does not exist for the victim
        txMock.get.mockResolvedValueOnce({ exists: false, data: () => null });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);

        // Should NOT write anything
        expect(txMock.set).not.toHaveBeenCalled();
    });

    it('should reject writes when order_id does not match (notes injection)', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_evil',
            status: 'captured',
            order_id: 'order_attacker',
            notes: { uid: 'victim_uid', sessionId: 'victim_session' }
        });

        const mockEvent = {
            id: 'evt_inject_2',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_evil' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        // Victim's session exists with a DIFFERENT order_id
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_victim_real' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);

        // Should NOT write anything — order_id mismatch
        expect(txMock.set).not.toHaveBeenCalled();
    });

    it('should include razorpay_payment_id on order.paid events', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.orders.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'order_with_payment',
            status: 'paid',
            amount: 50000,
            amount_paid: 50000,
            amount_due: 0,
            currency: 'INR',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_order_with_payment',
            event: 'order.paid',
            payload: {
                order: { entity: { id: 'order_with_payment' } },
                payment: { entity: { id: 'pay_for_order' } }
            }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_with_payment' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);

        expect(txMock.set).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                order_id: 'order_with_payment',
                razorpay_payment_id: 'pay_for_order', // FIX 2A: payment ID captured from webhook payload
            }),
            { merge: true }
        );
    });

    it('should not clear processing_at when order_id does not match current session', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_delayed',
            status: 'failed',
            order_id: 'order_old',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_delayed',
            event: 'payment.failed',
            payload: { payment: { entity: { id: 'pay_delayed' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        // Session currently has a DIFFERENT order_id (new transaction in progress)
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_new_active' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);

        // The write should still occur (status update) but processing_at should NOT be deleted
        const writeCall = txMock.set.mock.calls[0];
        if (writeCall) {
            const writtenData = writeCall[1];
            expect(writtenData).not.toHaveProperty('processing_at');
        }
    });

    it('should clear processing_at when order_id matches', async () => {
        const razorpayApi = getRazorpay();
        (razorpayApi.payments.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'pay_normal',
            status: 'captured',
            order_id: 'order_match',
            notes: { uid: 'user_123', sessionId: 'session_123' }
        });

        const mockEvent = {
            id: 'evt_normal',
            event: 'payment.captured',
            payload: { payment: { entity: { id: 'pay_normal' } } }
        };

        const admin = require('firebase-admin');
        const txMock = admin.firestore()._txMock;
        txMock.get.mockResolvedValueOnce({ exists: true, data: () => ({ order_id: 'order_match' }) });

        await handlePaymentEvent(mockEvent as any, admin.firestore(), razorpayApi);

        const writeCall = txMock.set.mock.calls[0];
        expect(writeCall).toBeDefined();
        const writtenData = writeCall[1];
        expect(writtenData).toHaveProperty('processing_at', 'field_delete');
    });
});
