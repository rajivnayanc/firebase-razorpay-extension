import { createSubscriptionHandler } from '../triggers/createSubscription';

// Mock firebase admin
jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
    };
    return {
        apps: [],
        initializeApp: jest.fn(),
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
        })
    };
});

// Mock razorpay
jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        subscriptions: {
            create: jest.fn((options) => {
                if (options.plan_id === 'invalid_plan') throw new Error('Invalid plan');
                return Promise.resolve({ id: 'sub_123', status: 'created', short_url: 'https://rzp.io/test' });
            })
        }
    }));
});

describe('Firestore Trigger: createSubscription', () => {
    let mockSnap: any;

    beforeEach(() => {
        mockSnap = {
            data: () => ({ plan_id: 'plan_123', razorpay_customer_id: 'cust_123' }),
            ref: {
                path: 'customers/user1/subscriptions/sub1',
                update: jest.fn().mockResolvedValue({})
            }
        };
    });

    it('Behavior: should successfully call Razorpay and update document', async () => {
        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' }));
        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            subscription_id: 'sub_123',
            status: 'created',
            short_url: 'https://rzp.io/test'
        }));
    });

    it('Behavior: should handle razorpay API errors gracefully', async () => {
        mockSnap.data = () => ({ plan_id: 'invalid_plan', razorpay_customer_id: 'cust_123' }); // Will trigger the mock error
        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed',
            error: 'Invalid plan'
        }));
    });
});
