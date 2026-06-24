import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { PermissionKey, isAdminRole, userHasPermission } from '../services/permissions.service';

type Role = 'SUPERADMIN' | 'OWNER' | 'JEFE' | 'ADMIN' | 'AGENTE';

export const requireRole = (...roles: Role[]) => {
    return (req: AuthRequest, res: Response, next: NextFunction) => {
        const role = req.user?.role as Role | undefined;

        if (!role || !roles.includes(role)) {
            return res.status(403).json({ message: 'No tiene permisos para realizar esta acción' });
        }

        next();
    };
};

export const requirePermission = (permission: PermissionKey) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
        const user = req.user;

        if (!user) {
            return res.status(401).json({ message: 'Token no proporcionado' });
        }

        try {
            const allowed = await userHasPermission(user.id, user.role, permission);

            if (!allowed) {
                return res.status(403).json({ message: 'No tiene permisos para realizar esta acción' });
            }

            next();
        } catch (error) {
            console.error('Error validating permission:', error);
            res.status(500).json({ message: 'Error validando permisos' });
        }
    };
};

export const requireAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
    const role = req.user?.role;

    if (!isAdminRole(role)) {
        return res.status(403).json({ message: 'No tiene permisos para realizar esta acción' });
    }

    next();
};

export const requireSuperAdmin = requireRole('SUPERADMIN');
