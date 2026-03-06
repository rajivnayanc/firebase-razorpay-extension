import { createOrderHandler } from '../triggers/createOrder';

const mockTransaction = {
    get: jest.fn(),
    update: jest.fn(),
};

// Mock firebase admin
jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn(mockTransaction)),
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

    it('Behavior: should acquire transaction lock then create order', async () => {
        // Transaction read: document has no status yet
        mockTransaction.get.mockResolvedValue({
            data: () => ({ amount: 50000 }),
        });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Verify transaction acquired the lock
        expect(mockTransaction.update).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'processing' })
        );

        // Verify order was created and doc was updated
        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            order_id: 'order_123',
            status: 'created'
        }));
    });

    it('Behavior: should SKIP if document is already processing (prevents double order)', async () => {
        mockTransaction.get.mockResolvedValue({
            data: () => ({ amount: 50000, status: 'processing' }), // Already locked!
        });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Transaction should NOT update — another trigger already has the lock
        expect(mockTransaction.update).not.toHaveBeenCalled();
        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should SKIP if document already has paid status', async () => {
        mockTransaction.get.mockResolvedValue({
            data: () => ({ amount: 50000, status: 'paid', order_id: 'order_existing' }),
        });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        expect(mockTransaction.update).not.toHaveBeenCalled();
        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT zero or negative amounts (server-side validation)', async () => {
        mockTransaction.get.mockResolvedValue({
            data: () => ({ amount: 0 }), // Invalid!
        });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Should set failed status inside the transaction
        expect(mockTransaction.update).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('Invalid amount')
            })
        );
    });

    it('Behavior: should handle razorpay API errors gracefully', async () => {
        mockTransaction.get.mockResolvedValue({
            data: () => ({ amount: -100 }), // Negative amount will cause Razorpay error
        });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        // Should have set failed status
        expect(mockTransaction.update).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'failed' })
        );
    });
});
