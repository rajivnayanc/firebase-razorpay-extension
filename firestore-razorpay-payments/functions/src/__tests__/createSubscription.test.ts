import { createSubscriptionHandler } from '../triggers/createSubscription';

const mockTransaction = {
    get: jest.fn(),
    update: jest.fn(),
};

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

describe('Firestore Trigger: createSubscription (with Transaction Lock)', () => {
    let mockSnap: any;

    beforeEach(() => {
        mockSnap = {
            data: () => ({ plan_id: 'plan_123' }),
            ref: {
                path: 'customers/user1/subscriptions/sub1',
                update: jest.fn().mockResolvedValue({})
            }
        };
        mockTransaction.get.mockReset();
        mockTransaction.update.mockReset();
        jest.clearAllMocks();
    });

    it('Behavior: should acquire transaction lock then create subscription', async () => {
        mockTransaction.get
            .mockResolvedValueOnce({ exists: true, data: () => ({ plan_id: 'plan_123' }) }) // 1. Sub Doc
            .mockResolvedValueOnce({ exists: true, data: () => ({}) }); // 2. Plan Doc

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        // Verify transaction acquired the lock
        expect(mockTransaction.update).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ status: 'processing' })
        );

        // Verify subscription was created and doc was updated
        expect(mockSnap.ref.update).toHaveBeenCalledWith(expect.objectContaining({
            subscription_id: 'sub_123',
            status: 'created'
        }));
    });

    it('Behavior: should SKIP if already processing (prevents double subscription)', async () => {
        mockTransaction.get
            .mockResolvedValueOnce({ exists: true, data: () => ({ plan_id: 'plan_123', status: 'processing', processing_at: { toDate: () => new Date() } }) })
            .mockResolvedValueOnce({ exists: true, data: () => ({}) });

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockTransaction.update).not.toHaveBeenCalled();
        expect(mockSnap.ref.update).not.toHaveBeenCalled();
    });

    it('Behavior: should REJECT missing plan_id (server-side validation)', async () => {
        mockTransaction.get
            .mockResolvedValueOnce({ exists: true, data: () => ({ amount: 500 }) }); // Fails immediately, won't fetch plan doc

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockTransaction.update).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('plan_id')
            })
        );
    });

    it('Behavior: should REJECT if plan_id does not exist in synced plans', async () => {
        mockTransaction.get
            .mockResolvedValueOnce({ exists: true, data: () => ({ plan_id: 'plan_123' }) }) // 1. Sub Doc
            .mockResolvedValueOnce({ exists: false, data: () => ({}) }); // 2. Plan Doc (Doesn't exist)

        const mockEvent = {
            data: mockSnap,
            params: { customers_collection: 'customers', uid: 'user1', id: 'sub1' }
        };

        await createSubscriptionHandler(mockEvent as any);

        expect(mockTransaction.update).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                status: 'failed',
                error: expect.stringContaining('not found in synced plans')
            })
        );
    });
});
