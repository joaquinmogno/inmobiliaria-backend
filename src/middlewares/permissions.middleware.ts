import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth.middleware';
import { PermissionKey, userHasPermission } from '../services/permissions.service';
import { auditService, getAuditRequestMetadata } from '../services/audit.service';
import { logger } from '../services/logger.service';

const auditDeniedAccess = async (req: AuthRequest, permission: string, reason: string) => {
    const user = req.user;
    if (!user) return;
    await auditService.log({
        usuarioId: user.id,
        inmobiliariaId: user.inmobiliariaId,
        accion: 'ACCESO_DENEGADO',
        entidad: 'Permiso',
        detalle: JSON.stringify({ permission, reason, method: req.method, path: req.originalUrl }),
        severidad: 'WARNING',
        resultado: 'FALLIDO',
        ...getAuditRequestMetadata(req)
    });
};

export const requirePermission = (permission: PermissionKey) => {
    return async (req: AuthRequest, res: Response, next: NextFunction) => {
        const user = req.user;
        if (!user) return res.status(401).json({ message: 'Sesión no proporcionada' });

        try {
            if (!(await userHasPermission(user.id, user.tipo, permission))) {
                await auditDeniedAccess(req, permission, 'PERMISSION_MISSING');
                return res.status(403).json({ message: 'No tiene permisos para realizar esta acción' });
            }
            next();
        } catch (error) {
            logger.error('Permission validation failed', {
                requestId: req.requestId,
                userId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                permission,
                error
            });
            await auditDeniedAccess(req, permission, 'PERMISSION_CHECK_FAILED');
            res.status(500).json({ message: 'Error validando permisos' });
        }
    };
};

export const requireAdmin = async (req: AuthRequest, res: Response, next: NextFunction) => {
    if (req.user?.tipo !== 'ADMIN') {
        await auditDeniedAccess(req, 'ADMIN', 'ADMIN_REQUIRED');
        return res.status(403).json({ message: 'Esta acción requiere una cuenta administradora' });
    }
    next();
};
