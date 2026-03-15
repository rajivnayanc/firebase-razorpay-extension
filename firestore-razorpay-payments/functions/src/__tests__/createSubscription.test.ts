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
            data: () => ({ plan_id: 'plan_123' }),
            ref: {
                path: 'customers/user1/subscriptions/sub1',
                update: jest.fn().mockResolvedValue({})
            }
        };
        jest.clearAllMocks();
    });

    it('Behavior: should create subscription', async () => {
        // We need to properly mock the firestore db.collection().doc().get() return because createSubscription queries the plan.
        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({}) });
        const firestoreMock = {
            collection: jest.fn().mockReturnThis(),
            doc: jest.fn().mockReturnThis(),
            get: mockSnapGet,
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

    it('Behavior: should SKIP if already processing (prevents double subscription)', async () => {
        mockSnap.data = () => ({ plan_id: 'plan_123', status: 'processing', processing_at: { toDate: () => new Date() } });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT missing plan_id (server-side validation)', async () => {
        mockSnap.data = () => ({ amount: 500 }); // Fails immediately, won't fetch plan doc
        const mockSnapGet = jest.fn().mockResolvedValue({ exists: true, data: () => ({ amount: 500 }) });
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
                error: expect.stringContaining('plan_id')
            })
        );
    });

    it('Behavior: should REJECT if plan_id does not exist in synced plans', async () => {
        const mockSnapGet = jest.fn().mockResolvedValue({ exists: false }); // Plan Doc (Doesn't exist)
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
                error: expect.stringContaining('not found in synced plans')
            })
        );
    });
});
