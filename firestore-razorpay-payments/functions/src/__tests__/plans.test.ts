import request from 'supertest';
import app from '../api';

let mockCustomClaims = {};

// Mock the whole firebase-admin module to avoid initializing it
jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue({
            docs: [
                { data: () => ({ id: 'plan_1', item: { name: 'Plan 1', amount: 500 }, active: true }) }
            ]
        }),
        where: jest.fn().mockReturnThis(),
    };

    return {
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
        }),
        auth: jest.fn(() => ({
            verifyIdToken: jest.fn().mockImplementation(async (token) => {
                if (token === 'invalid') throw new Error('Invalid token');
                return { uid: 'mock_user_123', ...mockCustomClaims };
            })
        })),
    };
});

// Mock getRazorpay internal module call safely since it's lazy loaded
jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        plans: {
            create: jest.fn().mockResolvedValue({ id: 'plan_new123', item: { name: 'New Plan', amount: 500, active: true } }),
            all: jest.fn().mockResolvedValue({
                items: [{ id: 'plan_sync1', item: { name: 'Sync Plan 1', active: true } }]
            })
        }
    }));
});

describe('Plan API Endpoints', () => {
    beforeEach(() => {
        mockCustomClaims = {};
    });

    describe('GET /plans', () => {
        it('Behavior: should allow authenticated users to fetch plans', async () => {
            const res = await request(app)
                .get('/plans')
                .set('Authorization', 'Bearer dummy_token');

            expect(res.status).toBe(200);
            expect(res.body.items).toBeDefined();
            expect(res.body.items.length).toBe(1);
            expect(res.body.items[0].id).toBe('plan_1');
        });

        it('Behavior: should reject unauthenticated requests', async () => {
            const res = await request(app).get('/plans');
            expect(res.status).toBe(403);
        });
    });

    describe('Admin Plan Management', () => {
        it('Behavior: should reject POST /admin/plans without admin claim', async () => {
            const res = await request(app)
                .post('/admin/plans')
                .set('Authorization', 'Bearer dummy_token')
                .send({
                    period: 'monthly',
                    interval: 1,
                    item: { name: 'Test', amount: 500 }
                });

            expect(res.status).toBe(403);
            expect(res.body.error).toContain('Admin access required');
        });

        it('Behavior: should allow POST /admin/plans with admin claim', async () => {
            mockCustomClaims = { admin: true };
            const res = await request(app)
                .post('/admin/plans')
                .set('Authorization', 'Bearer valid_admin_token')
                .send({
                    period: 'monthly',
                    interval: 1,
                    item: { name: 'Test Plan', amount: 50000, currency: 'INR' }
                });

            expect(res.status).toBe(201);
            expect(res.body.id).toBe('plan_new123');
        });

        it('Behavior: should reject POST /admin/plans/sync without admin claim', async () => {
            const res = await request(app)
                .post('/admin/plans/sync')
                .set('Authorization', 'Bearer dummy_token');

            expect(res.status).toBe(403);
        });

        it('Behavior: should allow POST /admin/plans/sync with admin claim', async () => {
            mockCustomClaims = { admin: true };
            const res = await request(app)
                .post('/admin/plans/sync')
                .set('Authorization', 'Bearer valid_admin_token');

            expect(res.status).toBe(200);
            expect(res.body.status).toBe('SUCCESS');
            expect(res.body.count).toBe(1);
        });
    });
});
