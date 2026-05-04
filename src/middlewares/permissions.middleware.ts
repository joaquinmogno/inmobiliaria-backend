import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';

type Role = 'SUPERADMIN' | 'ADMIN' | 'AGENTE';

export const requireRole = (...roles: Role[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const role = req.user?.role as Role | undefined;

        if (!role || !roles.includes(role)) {
            return res.status(403).json({ message: 'No tiene permisos para realizar esta acción' });
        }

        next();
    };
};

export const requireAdmin = requireRole('ADMIN', 'SUPERADMIN');
export const requireSuperAdmin = requireRole('SUPERADMIN');
