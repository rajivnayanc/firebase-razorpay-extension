import { createOrder } from '../triggers/createOrder';

// Mock firebase admin
jest.mock('firebase-admin', () => ({
    apps: [],
    initializeApp: jest.fn(),
    firestore: {
        FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
    }
}));

// Mock razorpay
jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        orders: {
            create: jest.fn((options) => {
                if (options.amount === 0) throw new Error('Invalid amount');
                return Promise.resolve({ id: 'order_123' });
            })
        }
    }));
});

describe('Firestore Trigger: createOrder', () => {
    let mockEvent: any;
    let mockSnap: any;

    beforeEach(() => {
        mockSnap = {
            data: () => ({ amount: 100 }),
            ref: {
                path: 'customers/user1/checkout_sessions/session1',
                update: jest.fn().mockResolvedValue({})
            }
        };

        mockEvent = {
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' },
            data: mockSnap
        };
    });

    it('Behavior: should successfully call Razorpay and update document', async () => {
        // We execute the trigger via a hack since firebase-functions-test relies on full emulator setup for v2
        // For unit testing the logic, we can cast the exported function
        const wrappedFn = createOrder as any;

        await wrappedFn(mockEvent);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({ status: 'processing' }));
        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            order_id: 'order_123',
            status: 'created'
        }));
    });

    it('Behavior: should handle razorpay API errors gracefully', async () => {
        mockSnap.data = () => ({ amount: 0 }); // Will trigger the mock error
        const wrappedFn = createOrder as any;

        await wrappedFn(mockEvent);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            status: 'failed',
            error: 'Invalid amount'
        }));
    });
});
