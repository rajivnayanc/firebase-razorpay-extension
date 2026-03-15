import { createOrderHandler } from '../triggers/createOrder';



// Mock firebase admin
jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn()), // Simplified
    };
    return {
        apps: [],
        initializeApp: jest.fn(),
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') },
            DocumentReference: class { },
        })
    };
});

// Mock razorpay
jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        orders: {
            create: jest.fn((options) => {
                if (options.amount <= 0) throw new Error('Invalid amount');
                return Promise.resolve({ id: 'order_123' });
            })
        }
    }));
});

describe('Firestore Trigger: createOrder (with Transaction Lock)', () => {
    let mockSnap: any;

    beforeEach(() => {
        mockSnap = {
            data: () => ({ amount: 50000 }),
            ref: {
                path: 'customers/user1/checkout_sessions/session1',
                update: jest.fn().mockResolvedValue({})
            }
        };
        jest.clearAllMocks();
    });

    it('Behavior: should acquire lock then create order', async () => {
        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Verify lock was acquired
        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'processing' })
        );

        // Verify order was created and doc was updated (second update call)
        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            order_id: 'order_123',
            status: 'created'
        }));
    });

    it('Behavior: should SKIP if document is already processing (prevents double order)', async () => {
        mockSnap = {
            data: () => ({ amount: 50000, status: 'processing', processing_at: { toDate: () => new Date() } }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should SKIP if document already has paid status', async () => {
        mockSnap = {
            data: () => ({ amount: 50000, status: 'paid', order_id: 'order_existing' }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT zero or negative amounts (server-side validation)', async () => {
        mockSnap = {
            data: () => ({ amount: 0 }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Should set failed status
        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('Invalid amount')
            })
        );
    });

    it('Behavior: should handle razorpay API errors gracefully', async () => {
        mockSnap = {
            data: () => ({ amount: -100 }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Should have set failed status in response to Razorpay API Error
        // The first update sets processing, the second sets failed.
        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed' })
        );
    });
});
