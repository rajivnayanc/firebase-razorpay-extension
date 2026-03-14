import * as admin from 'firebase-admin';
import { Request, Response, NextFunction } from 'express';

export interface AuthenticatedRequest extends Request {
    user?: admin.auth.DecodedIdToken;
}

export const authenticate = async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
) => {
    const authorizationHeader = req.headers.authorization;

    if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
        res.status(403).send('Unauthorized: No token provided or invalid format.');
        return;
    }

    const idToken = authorizationHeader.split('Bearer ')[1];

    try {
        const decodedToken = await admin.auth().verifyIdToken(idToken);
        req.user = decodedToken;
        next();
    } catch (error) {
        res.status(403).send('Unauthorized: Invalid token.');
    }
};
