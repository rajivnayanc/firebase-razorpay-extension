import { syncClaimsHandler } from '../triggers/syncClaims';

jest.mock('../config', () => ({
    __esModule: true,
    default: {
        customersCollectionPath: 'customers',
        syncCustomClaims: true
    }
}));

jest.mock('firebase-admin', () => {
    const authMock = {
        getUser: jest.fn().mockResolvedValue({ customClaims: { 'admin': true } }),
        setCustomUserClaims: jest.fn().mockResolvedValue({})
    };
    
    const getMock = jest.fn();

    const firestoreMock = {
        collection: jest.fn().mockReturnThis(),
        doc: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        get: getMock
    };

    return {
        firestore: jest.fn(() => firestoreMock),
        auth: jest.fn(() => authMock)
    };
});

describe('Background Trigger: syncClaimsOnSubscriptionChange', () => {
    let mockAuth: any;
    let mockFirestoreGet: jest.Mock;

    beforeEach(() => {
        const admin = require('firebase-admin');
        mockAuth = admin.auth();
        mockFirestoreGet = admin.firestore().get;
        jest.clearAllMocks();
    });

    const invokeTrigger = async (uid: string) => {
        const mockEvent = {
            params: { uid },
            data: { before: null, after: null }
        };
        await syncClaimsHandler(mockEvent);
    };

    it('should compute exact roles based on active subscriptions and preserve non-Razorpay roles', async () => {
        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { admin: true, old_role: true } });

        const mockSnap = {
            forEach: (cb: any) => [
                { data: () => ({ firebaseRole: 'premium', status: 'active' }) },
                { data: () => ({ firebaseRole: 'video', status: 'authenticated' }) },
                { data: () => ({ firebaseRole: 'old_role', status: 'cancelled' }) }
            ].forEach(cb)
        };
        mockFirestoreGet.mockResolvedValueOnce(mockSnap);

        await invokeTrigger('user_123');

        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {
            admin: true,
            premium: true,
            video: true
        });
    });

    it('should remove roles if no longer active', async () => {
        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { premium: true } });

        const mockSnap = {
            forEach: (cb: any) => [
                { data: () => ({ firebaseRole: 'premium', status: 'cancelled' }) }
            ].forEach(cb)
        };
        mockFirestoreGet.mockResolvedValueOnce(mockSnap);

        await invokeTrigger('user_123');

        expect(mockAuth.setCustomUserClaims).toHaveBeenCalledWith('user_123', {});
    });

    it('should not call setCustomUserClaims if no changes are needed', async () => {
        mockAuth.getUser.mockResolvedValueOnce({ customClaims: { premium: true } });

        const mockSnap = {
            forEach: (cb: any) => [
                { data: () => ({ firebaseRole: 'premium', status: 'active' }) }
            ].forEach(cb)
        };
        mockFirestoreGet.mockResolvedValueOnce(mockSnap);

        await invokeTrigger('user_123');

        expect(mockAuth.setCustomUserClaims).not.toHaveBeenCalled();
    });
});
