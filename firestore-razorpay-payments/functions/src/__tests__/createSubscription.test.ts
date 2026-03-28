import { createSubscriptionHandler } from '../triggers/createSubscription';


jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn()),
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

jest.mock('razorpay', () => {
    return jest.fn().mockImplementation(() => ({
        subscriptions: {
            create: jest.fn((options) => {
                if (!options.plan_id) throw new Error('plan_id is required');
                return Promise.resolve({
                    id: 'sub_123',
                    status: 'created',
                    short_url: 'https://rzp.io/s/test',
                });
            })
        }
    }));
});

describe('Firestore Trigger: createSubscription', () => {
    let mockSnap: any;

    beforeEach(() => {
        mockSnap = {
            exists: true,
            data: () => ({ productId: 'prod_123', interval: 'monthly' }),
            ref: {
                path: 'customers/user1/subscriptions/sub1',
                update: jest.fn().mockResolvedValue({})
            }
        };
        jest.clearAllMocks();
    });

    it('Behavior: should create subscription', async () => {
        // We need to properly mock the firestore db.collection().doc().get() returns.
        // First get is the customer check. Second get is the product check.
        const mockSnapGet = jest.fn()
            .mockResolvedValueOnce({ exists: true, data: () => ({ razorpay_customer_id: 'cust_123' }) })
            .mockResolvedValueOnce({ exists: true, data: () => ({ allowedPlans: { monthly: 'plan_123' } }) });
        const firestoreMock = {
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            })),
        };
        require('firebase-admin').firestore.mockImplementation(() => firestoreMock);
        
        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        // Verify lock acquired
        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'processing' })
        );

        // Verify subscription was created and doc was updated
        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            subscription_id: 'sub_123',
            status: 'created'
        }));
    });

    it('Behavior: should use total_count from product document, overriding client input', async () => {
        mockSnap.data = () => ({ productId: 'prod_123', interval: 'monthly', total_count: 5 }); // Client asks for 5
        const mockSnapGet = jest.fn()
            .mockResolvedValueOnce({ exists: true, data: () => ({ razorpay_customer_id: 'cust_123' }) })
            .mockResolvedValueOnce({ exists: true, data: () => ({ allowedPlans: { monthly: 'plan_123' }, total_count: 24 }) }); // Product enforces 24
            
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            }))
        }));

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        const { getRazorpay } = require('../api');
        await createSubscriptionHandler(mockEvent as any);

        // Verify Razorpay API was called with 24, not 5
        expect(getRazorpay().subscriptions.create).toHaveBeenCalledWith(
            expect.objectContaining({ total_count: 24 })
        );
    });

    it('Behavior: should SKIP if already processing (prevents double subscription)', async () => {
        mockSnap.data = () => ({ productId: 'prod_123', interval: 'monthly', status: 'processing', processing_at: { toDate: () => new Date() } });

        const mockSnapGet = jest.fn()
            .mockResolvedValueOnce({ exists: true, data: () => ({ razorpay_customer_id: 'cust_123' }) })
            .mockResolvedValueOnce({ exists: true, data: () => ({ allowedPlans: { monthly: 'plan_123' } }) });

        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
            runTransaction: jest.fn(async (fn: any) => fn({
                get: jest.fn().mockResolvedValue(mockSnap),
                update: (...args: any[]) => mockSnap.ref.update(...args.slice(1)),
                set: (...args: any[]) => mockSnap.ref.update(...args.slice(1))
            }))
        }));

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT missing plan_id (server-side validation)', async () => {
        mockSnap.data = () => ({ productId: 'prod_123', interval: 'monthly', amount: 500 }); // Missing plan_id allowed in input, but resolved to empty
        const mockSnapGet = jest.fn()
            .mockResolvedValueOnce({ exists: true, data: () => ({ razorpay_customer_id: 'cust_123' }) })
            .mockResolvedValueOnce({ exists: true, data: () => ({ amount: 500 }) });
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
        }));

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('The selected plan is not available') // Now the error text changed: "No plan for interval..." or similar, depending on the sanitize update.
            })
        );
    });

    it('Behavior: should safely reject non-string or oversized required fields (Input Fuzzing)', async () => {
        const testCases = [
            { productId: 12345, interval: 'monthly' }, // Number productId
            { productId: 'prod_1', interval: { sql: 'injection' } }, // Object interval
            { productId: 'a'.repeat(300), interval: 'monthly' }, // Oversized string
            { productId: 'prod_1', interval: 'a'.repeat(70) } // Oversized string
        ];

        const mockSnapGet = jest.fn()
            .mockResolvedValue({ exists: true, data: () => ({ razorpay_customer_id: 'cust_123' }) });
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
        }));

        for (const testCase of testCases) {
            const tempSnap = { data: () => testCase, ref: { update: jest.fn().mockResolvedValue({}) } };
            const mockEvent = { data: tempSnap, params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' } };
            
            await createSubscriptionHandler(mockEvent as any);
            
            expect(tempSnap.ref.update).toHaveBeenCalledWith(
                expect.objectContaining({ status: 'failed', error: expect.stringContaining('valid strings') })
            );
        }
    });

    it('Behavior: should REJECT if plan_id does not exist in synced plans', async () => {
        const mockSnapGet = jest.fn()
            .mockResolvedValueOnce({ exists: true, data: () => ({ razorpay_customer_id: 'cust_123' }) }) // Customer Doc
            .mockResolvedValueOnce({ exists: false }); // Plan Doc (Doesn't exist)
            
        require('firebase-admin').firestore.mockImplementation(() => ({
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
        }));

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockSnap.ref.update).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('product is not available')
            })
        );
    });
});
