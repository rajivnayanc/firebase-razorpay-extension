import { Response, NextFunction } from 'express';
import { AuthenticatedRequest } from './authenticate';

export const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user || (req.user.admin !== true && req.user.role !== 'admin')) {
        res.status(403).json({ error: 'Forbidden: Admin access required.' });
        return;
    }
    next();
};
