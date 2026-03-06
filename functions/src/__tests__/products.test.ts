import { handleProductEvent } from '../handlers/products';

jest.mock('firebase-admin', () => {
    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        set: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
    };
    return {
        firestore: jest.fn(() => firestoreMock),
    };
});

describe('Webhook Handler: products', () => {
    let mockDb: any;

    beforeEach(() => {
        mockDb = require('firebase-admin').firestore();
        jest.clearAllMocks();
    });

    it('Behavior: should insert or update a product on item.created', async () => {
        const mockEvent = {
            event: 'item.created',
            payload: {
                item: {
                    entity: { id: 'item_123', name: 'Test Product', amount: 50000 }
                }
            }
        };

        await handleProductEvent(mockEvent);

        expect(mockDb.collection).toHaveBeenCalledWith('products');
        expect(mockDb.doc).toHaveBeenCalledWith('item_123');
        expect(mockDb.set).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'item_123',
                name: 'Test Product',
                amount: 50000,
                _razorpay_event: 'item.created'
            }),
            { merge: true }
        );
    });

    it('Behavior: should delete a product on item.deleted', async () => {
        const mockEvent = {
            event: 'item.deleted',
            payload: {
                item: {
                    entity: { id: 'item_del_123' }
                }
            }
        };

        await handleProductEvent(mockEvent);

        expect(mockDb.doc).toHaveBeenCalledWith('item_del_123');
        expect(mockDb.delete).toHaveBeenCalled();
        expect(mockDb.set).not.toHaveBeenCalled();
    });
});
