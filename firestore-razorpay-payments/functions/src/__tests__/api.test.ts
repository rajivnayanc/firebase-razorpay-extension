import * as crypto from 'crypto';
import { webhookHandlerFunc } from '../api';

// Mock the whole firebase-admin module to avoid initializing it
jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn()),
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
        const req: any = {
            method: 'POST',
            body: payload,
            rawBody: Buffer.from(payloadStr),
            headers: { 'x-razorpay-signature': 'invalid' }
        };
        const res: any = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn(),
            json: jest.fn(),
        };

        await webhookHandlerFunc(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Invalid Signature' }));
    });

    it('Behavior: should accept valid signatures and process webhook', async () => {
        const req: any = {
            method: 'POST',
            body: payload,
            rawBody: Buffer.from(payloadStr),
            headers: { 'x-razorpay-signature': signature }
        };
        const res: any = {
            status: jest.fn().mockReturnThis(),
            send: jest.fn(),
        };

        await webhookHandlerFunc(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.send).toHaveBeenCalledWith('Webhook Processed');
    });
});
