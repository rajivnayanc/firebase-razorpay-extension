import { handleProductEvent } from '../handlers/products';

const mockTransaction = {
    get: jest.fn(),
    set: jest.fn(),
    delete: jest.fn(),
};

jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        runTransaction: jest.fn(async (fn: any) => fn(mockTransaction)),
    };
    return {
        firestore: Object.assign(jest.fn(() => firestoreMock), {
            FieldValue: { serverTimestamp: jest.fn(() => 'server_time') }
        }),
    };
});

describe('Webhook Handler: products (with Transactions & Sanitization)', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        // Default: dedup doc doesn't exist
        mockTransaction.get.mockResolvedValue({ exists: false });
    });

    it('Behavior: should sync product data with sanitized fields on item.created', async () => {
        const mockEvent = {
            id: 'evt_prod_1',
            event: 'item.created',
            payload: {
                item: {
                    entity: {
                        id: 'item_123',
                        name: 'Test Product',
                        description: 'A test product',
                        amount: 5000,
                        currency: 'INR',
                        // Unsafe fields that should be stripped
                        __v: 0,
                        internal_metadata: { secret: 'leak' },
                    }
                }
            }
        };

        await handleProductEvent(mockEvent);

        // Should write sanitized data (no __v, no internal_metadata)
        expect(mockTransaction.set).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                id: 'item_123',
                name: 'Test Product',
                amount: 5000,
                _razorpay_event: 'item.created',
            }),
            { merge: true }
        );

        // Verify unsafe fields were stripped
        const writtenData = mockTransaction.set.mock.calls[0][1];
        expect(writtenData.__v).toBeUndefined();
        expect(writtenData.internal_metadata).toBeUndefined();
    });

    it('Behavior: should delete product document on item.deleted', async () => {
        const mockEvent = {
            id: 'evt_prod_del',
            event: 'item.deleted',
            payload: {
                item: {
                    entity: { id: 'item_del_123' }
                }
            }
        };

        await handleProductEvent(mockEvent);

        expect(mockTransaction.delete).toHaveBeenCalled();
    });

    it('Behavior: should SKIP duplicate product events', async () => {
        // Dedup doc exists
        mockTransaction.get.mockResolvedValue({ exists: true });

        const mockEvent = {
            id: 'evt_prod_dup',
            event: 'item.created',
            payload: {
                item: {
                    entity: { id: 'item_123', name: 'Test Product' }
                }
            }
        };

        await handleProductEvent(mockEvent);

        // Only the dedup get should have been called, no writes
        expect(mockTransaction.set).not.toHaveBeenCalled();
    });
});
