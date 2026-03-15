import request from 'supertest';
import app from '../api';
import * as crypto from 'crypto';

// Mock the whole firebase-admin module to avoid initializing it
jest.mock('firebase-admin', () => {
    const mockTransaction = {
        get: jest.fn().mockResolvedValue({
            exists: true,
            data: () => ({ status: 'created', order_id: 'order_123' })
        }),
        set: jest.fn(),
    };
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
        auth: jest.fn(() => ({
            setCustomUserClaims: jest.fn().mockResolvedValue({}),
            verifyIdToken: jest.fn().mockResolvedValue({ uid: 'mock_user_123' })
        })),
    };
});

jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        orders: {
            fetch: jest.fn().mockResolvedValue({
                id: 'order_123',
                status: 'paid',
                notes: { uid: 'mock_user_123', sessionId: 'session_123' }
            })
        }
    }));
});

describe('Webhook API', () => {
    const payload = {
        event: 'payment.captured',
        payload: {
            payment: {
                entity: { id: 'pay_123', notes: { uid: 'u1', sessionId: 's1' } }
            }
        }
    };
    const payloadStr = JSON.stringify(payload);
    const signature = crypto.createHmac('sha256', 'test_webhook_secret').update(payloadStr).digest('hex');

    it('Behavior: should reject requests with invalid signature', async () => {
        const res = await request(app)
            .post('/webhook')
            .set('x-razorpay-signature', 'invalid')
            .send(payload);

        expect(res.status).toBe(400);
        expect(res.text).toContain('Invalid Signature');
    });

    it('Behavior: should accept valid signatures and process webhook', async () => {
        const res = await request(app)
            .post('/webhook')
            .set('x-razorpay-signature', signature)
            .set('Content-Type', 'application/json')
            .send(payloadStr);

        expect(res.status).toBe(200);
        expect(res.text).toBe('Webhook Processed');
    });
});

describe('Verify Payment Synchronous API', () => {
    it('Behavior: should reject requests without a valid auth token', async () => {
        const res = await request(app)
            .post('/verify-payment')
            .send({});

        expect(res.status).toBe(403);
    });

    it('Behavior: should accept valid verification payloads and sync session', async () => {
        const res = await request(app)
            .post('/verify-payment')
            .set('Authorization', 'Bearer dummy_token')
            .send({
                razorpay_order_id: 'order_123',
                sessionId: 'session_123'
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('PASSED');
        const razorpayInstance = require('../api').getRazorpay();
        expect(razorpayInstance.orders.fetch).toHaveBeenCalledWith('order_123');
    });

    it('Behavior: should strictly reject mismatching order ownership', async () => {
        const razorpayInstance = require('../api').getRazorpay();
        (razorpayInstance.orders.fetch as jest.Mock).mockResolvedValueOnce({
            id: 'order_123',
            status: 'paid',
            notes: { uid: 'different_user', sessionId: 'session_123' } // Mismatch ownership
        });

        const res = await request(app)
            .post('/verify-payment')
            .set('Authorization', 'Bearer dummy_token')
            .send({
                razorpay_order_id: 'order_123',
                sessionId: 'session_123'
            });

        expect(res.status).toBe(400);
        expect(res.body.status).toBe('FAILED');
    });
});
