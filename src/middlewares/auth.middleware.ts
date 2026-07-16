import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma';
import { CSRF_COOKIE, SESSION_COOKIE, sha256 } from '../services/security.service';

export interface AuthRequest extends Request {
    requestId?: string;
    sessionId?: number;
    csrfToken?: string;
    user?: {
        id: number;
        email: string;
        role: string;
        inmobiliariaId: number;
        mustChangePassword?: boolean;
    };
}

const RECENT_AUTH_MS = 15 * 60 * 1000;

export const requireRecentAuthentication = (req: Request, res: Response, next: NextFunction) => {
    const authenticatedAt = (req as Request & { sessionAuthenticatedAt?: Date }).sessionAuthenticatedAt;
    if (!authenticatedAt || Date.now() - authenticatedAt.getTime() > RECENT_AUTH_MS) {
        return res.status(403).json({ message: 'Por seguridad, volvé a confirmar tu contraseña', code: 'REAUTHENTICATION_REQUIRED' });
    }
    next();
};

const unsafeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const authenticateToken = async (req: Request, res: Response, next: NextFunction) => {
    const sessionToken = req.cookies?.[SESSION_COOKIE];

    if (!sessionToken || typeof sessionToken !== 'string') {
        return res.status(401).json({ message: 'Sesión no proporcionada' });
    }

    try {
        const session = await prisma.userSession.findUnique({
            where: { tokenHash: sha256(sessionToken) },
            include: { usuario: { include: { inmobiliaria: true } } }
        });

        if (!session || session.revokedAt || session.expiresAt <= new Date()) {
            return res.status(401).json({ message: 'Sesión expirada o revocada' });
        }

        const user = session.usuario;
        if (!user.activo || session.sessionVersion !== user.sessionVersion) {
            return res.status(401).json({ message: 'Sesión revocada' });
        }

        if (user.rol !== 'SUPERADMIN' && (!user.inmobiliaria || !user.inmobiliaria.activa)) {
            return res.status(403).json({ message: 'Cuenta suspendida, contacte al administrador' });
        }

        const authMaintenancePaths = new Set([
            '/api/auth/me',
            '/api/auth/logout',
            '/api/auth/change-password'
        ]);

        if (user.mustChangePassword && !authMaintenancePaths.has(req.originalUrl.split('?')[0])) {
            return res.status(403).json({
                message: 'Debe cambiar la contraseña para continuar',
                code: 'PASSWORD_CHANGE_REQUIRED'
            });
        }

        if (unsafeMethods.has(req.method)) {
            const csrfHeader = req.get('x-csrf-token');
            const csrfCookie = req.cookies?.[CSRF_COOKIE];

            if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie || sha256(csrfHeader) !== session.csrfTokenHash) {
                return res.status(403).json({ message: 'Token CSRF inválido' });
            }
        }

        await prisma.userSession.update({
            where: { id: session.id },
            data: { lastSeenAt: new Date() }
        }).catch(() => undefined);

        (req as AuthRequest).sessionId = session.id;
        (req as Request & { sessionAuthenticatedAt?: Date }).sessionAuthenticatedAt = session.authenticatedAt || session.createdAt;
        (req as AuthRequest).csrfToken = req.cookies?.[CSRF_COOKIE];
        (req as AuthRequest).user = {
            id: user.id,
            email: user.email,
            role: user.rol,
            inmobiliariaId: user.inmobiliariaId,
            mustChangePassword: user.mustChangePassword
        };
        next();
    } catch (error) {
        return res.status(500).json({ message: 'Error validando sesión' });
    }
};
