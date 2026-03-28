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
            }),
            all: jest.fn().mockResolvedValue({ items: [] })
        }
    }));
});

describe('Firestore Trigger: createOrder (with Transaction Lock)', () => {
    let mockSnap: any;

    beforeEach(() => {
        mockSnap = {
            exists: true,
            data: () => ({ productId: 'prod_123' }),
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

        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: 50000 }) });
        const firestoreMock = {
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue({ exists: true, ...mockSnap }),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1)) // fallback
            })),
        };
        require('firebase-admin').firestore.mockImplementation(() => firestoreMock);
        
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

    it('Behavior: should use currency from product document, ignoring client currency', async () => {
        mockSnap = {
            exists: true,
            data: () => ({ productId: 'prod_123', currency: 'USD' }), // Client sends USD
            ref: mockSnap.ref
        };
        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: 50000, currency: 'GBP' }) }); // Product requires GBP
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue({ exists: true, ...mockSnap }),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1)) // fallback
            })),
        }));
        
        const { getRazorpay } = require('../api');
        
        await createOrderHandler(mockEvent as any);

        // Verify it sent GBP to Razorpay API, not USD
        expect(getRazorpay().orders.create).toHaveBeenCalledWith(
            expect.objectContaining({ currency: 'GBP' })
        );
    });

    it('Behavior: should SKIP if document is already processing (prevents double order)', async () => {
        mockSnap = {
            exists: true,
            data: () => ({ productId: 'prod_123', status: 'processing', processing_at: { toDate: () => new Date() } }),
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
            exists: true,
            data: () => ({ productId: 'prod_123', status: 'paid', order_id: 'order_existing' }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);

        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should safely reject non-string or oversized productId (Input Fuzzing)', async () => {
        const testCases = [
            { productId: 12345 }, // Number
            { productId: { sql: 'injection' } }, // Object
            { productId: 'a'.repeat(300) } // Oversized string
        ];

        for (const testCase of testCases) {
            const tempSnap = { data: () => testCase, ref: { update: jest.fn().mockResolvedValue({}) } };
            const mockEvent = { data: tempSnap, params: { customers_collection: 'customers', uid: 'user1', id: 'session1' } };
            
            await createOrderHandler(mockEvent as any);
            
            expect(tempSnap.ref.update).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'failed', error: expect.stringContaining('valid productId string') })
            );
        }
    });

    it('Behavior: should REJECT zero or negative amounts (server-side validation)', async () => {
        mockSnap = {
            data: () => ({ productId: 'prod_123' }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: 0 }) });
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            })),
        }));
        await createOrderHandler(mockEvent as any);

        // Should set failed status
        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('invalid configuration')
            })
        );
    });

    it('Behavior: should handle razorpay API errors gracefully', async () => {
        mockSnap = {
            data: () => ({ productId: 'prod_123' }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: -100 }) });
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            })),
        }));
        await createOrderHandler(mockEvent as any);

        // Should have set failed status in response to Razorpay API Error
        // The first update sets processing, the second sets failed.
        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'failed' })
        );
    });

    it('Behavior: should return early if no data is associated with the event', async () => {
        const mockEvent = {
            data: null,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);
        // No updates should happen
        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should return early for subscription mode', async () => {
        mockSnap = {
            exists: true,
            data: () => ({ productId: 'prod_123', mode: 'subscription' }),
            ref: mockSnap.ref
        };

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        await createOrderHandler(mockEvent as any);
        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should reuse existing order if found via receipt', async () => {
        const { getRazorpay } = require('../api');
        const razorpayMock = getRazorpay();
        razorpayMock.orders.all.mockResolvedValueOnce({
            items: [{ id: 'order_reused', receipt: 'session1', status: 'created' }]
        });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: 50000 }) });
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            })),
        }));
        await createOrderHandler(mockEvent as any);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            order_id: 'order_reused',
            status: 'created'
        }));
    });

    it('Behavior: should handle API error in order lookup and fallback to create', async () => {
        const { getRazorpay } = require('../api');
        const razorpayMock = getRazorpay();
        razorpayMock.orders.all.mockRejectedValueOnce(new Error('Fetch failed'));
        razorpayMock.orders.create.mockResolvedValueOnce({ id: 'order_fallback' });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'session1' }
        };

        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: 50000 }) });
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            })),
        }));
        await createOrderHandler(mockEvent as any);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            order_id: 'order_fallback',
            status: 'created'
        }));
    });
});
