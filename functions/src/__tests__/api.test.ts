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
        expect(res.text).toBe('Invalid Signature');
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

    it('Behavior: should accept valid verification signatures', async () => {
        const payloadStr = 'order_123' + '|' + 'pay_123';
        const signature = crypto.createHmac('sha256', 'test_key_secret').update(payloadStr).digest('hex');

        const res = await request(app)
            .post('/verify-payment')
            .set('Authorization', 'Bearer dummy_token')
            .send({
                razorpay_order_id: 'order_123',
                razorpay_payment_id: 'pay_123',
                razorpay_signature: signature,
                sessionId: 'session_123'
            });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('PASSED');
    });

    it('Behavior: should strictly reject invalid verification signatures', async () => {
        const res = await request(app)
            .post('/verify-payment')
            .set('Authorization', 'Bearer dummy_token')
            .send({
                razorpay_order_id: 'order_123',
                razorpay_payment_id: 'pay_123',
                razorpay_signature: 'invalid_signature_attempt',
                sessionId: 'session_123'
            });

        expect(res.status).toBe(400);
        expect(res.body.status).toBe('FAILED');
    });
});
