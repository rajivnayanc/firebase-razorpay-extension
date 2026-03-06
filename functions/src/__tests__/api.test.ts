import request from 'supertest';
import app from '../api';
import * as crypto from 'crypto';

// Mock the whole firebase-admin module to avoid initializing it
jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
    };
    return {
        firestore: jest.fn(() => firestoreMock),
        auth: jest.fn(() => ({
            setCustomUserClaims: jest.fn().mockResolvedValue({}),
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
