// Mock environment variables for config
process.env.RAZORPAY_KEY_ID = 'test_key_id';
process.env.RAZORPAY_KEY_SECRET = 'test_key_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook_secret';
process.env.CUSTOMERS_COLLECTION = 'customers';
process.env.PRODUCTS_COLLECTION = 'products';
process.env.ALLOWED_ORIGINS = '';
process.env.DEDUP_TTL_DAYS = '7';

jest.mock('firebase-functions/v2/firestore', () => ({
    onDocumentCreated: jest.fn(),
    onDocumentWritten: jest.fn(),
    onDocumentUpdated: jest.fn(),
    onDocumentDeleted: jest.fn(),
}));

jest.mock('firebase-functions', () => ({
    logger: {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    },
    https: {
        onRequest: jest.fn(),
    },
    firestore: {
        document: jest.fn().mockReturnValue({
            onDelete: jest.fn(),
            onWrite: jest.fn(),
            onUpdate: jest.fn(),
            onCreate: jest.fn()
        })
    }
}));
