import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import {
    clearLoginThrottle,
    loginThrottle,
    recordLoginFailure,
    sendLoginBackoffIfNeeded
} from '../middlewares/rateLimiter.middleware';
import { getUserPermissionDetails } from '../services/permissions.service';
import { auditService, getAuditRequestMetadata } from '../services/audit.service';
import {
    clearAuthCookies,
    createSession,
    getClientIp,
    getUserAgent,
    revokeAllUserSessions,
    revokeSession,
    validatePasswordStrength
} from '../services/security.service';

const router = Router();

const loginSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254),
    password: z.string().min(1, 'La contraseña es obligatoria').max(128)
}).strict();
const reauthenticateSchema = z.object({ password: z.string().min(1).max(128) }).strict();
const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida').max(128),
    newPassword: z.string().min(12, 'La nueva contraseña debe tener al menos 12 caracteres').max(128)
}).strict();
const adminResetSchema = z.object({
    newPassword: z.string().min(12, 'La contraseña temporal debe tener al menos 12 caracteres').max(128)
}).strict();

async function buildSessionUser(userId: number) {
    const user = await prisma.usuario.findUnique({
        where: { id: userId },
        include: { inmobiliaria: true, rol: { select: { id: true, nombre: true, activo: true } } }
    });
    if (!user) return null;

    const permissionDetails = await getUserPermissionDetails(user.id);
    return {
        id: user.id,
        email: user.email,
        fullName: user.nombreCompleto,
        nombreCompleto: user.nombreCompleto,
        tipo: user.tipo,
        role: user.tipo,
        rol: permissionDetails.rol,
        mustChangePassword: user.mustChangePassword,
        permissions: permissionDetails.permissions,
        inmobiliaria: user.inmobiliaria
    };
}

router.post('/login', loginThrottle, async (req, res) => {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ message: 'Datos de entrada inválidos', errors: validation.error.issues.map(issue => issue.message) });
    }
    const { email, password } = validation.data;

    try {
        const user = await prisma.usuario.findUnique({ where: { email }, include: { inmobiliaria: true, rol: true } });
        if (!user || !user.activo || (user.tipo === 'USUARIO' && !user.rol?.activo)) {
            const inmobiliariaId = user?.inmobiliariaId || (await prisma.inmobiliaria.findFirst({ select: { id: true } }))?.id;
            if (inmobiliariaId) await auditService.log({
                usuarioId: user?.id || null, inmobiliariaId,
                accion: 'LOGIN_FALLIDO', entidad: 'Auth', detalle: `Intento fallido para ${email}`,
                ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'WARNING', resultado: 'FALLIDO'
            });
            const throttle = await recordLoginFailure(req);
            if (sendLoginBackoffIfNeeded(res, throttle.retryAfterSeconds)) return;
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }
        if (!(await bcrypt.compare(password, user.password))) {
            await auditService.log({
                usuarioId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                accion: 'LOGIN_FALLIDO', entidad: 'Auth', detalle: `Intento fallido para ${email}`,
                ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'WARNING', resultado: 'FALLIDO'
            });
            const throttle = await recordLoginFailure(req);
            if (sendLoginBackoffIfNeeded(res, throttle.retryAfterSeconds)) return;
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }
        if (!user.inmobiliaria.activa) return res.status(403).json({ message: 'Cuenta suspendida, contacte al administrador' });

        await clearLoginThrottle(req);
        const session = await createSession({
            userId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            sessionVersion: user.sessionVersion,
            req,
            res
        });
        await prisma.usuario.update({ where: { id: user.id }, data: { ultimoAcceso: new Date() } });
        await auditService.log({
            usuarioId: user.id, inmobiliariaId: user.inmobiliariaId,
            accion: 'LOGIN_EXITOSO', entidad: 'Auth', detalle: `Inicio de sesión para ${email}`,
            ipAddress: getClientIp(req), userAgent: getUserAgent(req)
        });
        res.json({ csrfToken: session.csrfToken, expiresAt: session.expiresAt, user: await buildSessionUser(user.id) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor' });
    }
});

router.get('/me', authenticateToken, async (req, res) => {
    const sessionUser = await buildSessionUser((req as AuthRequest).user!.id);
    if (!sessionUser) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ ...sessionUser, csrfToken: (req as AuthRequest).csrfToken });
});

router.post('/logout', authenticateToken, async (req, res) => {
    const authReq = req as AuthRequest;
    if (authReq.sessionId) await revokeSession(authReq.sessionId);
    await auditService.log({
        usuarioId: authReq.user!.id, inmobiliariaId: authReq.user!.inmobiliariaId,
        accion: 'LOGOUT', entidad: 'Auth', ipAddress: getClientIp(req), userAgent: getUserAgent(req)
    });
    clearAuthCookies(res);
    res.json({ message: 'Sesión cerrada' });
});

router.post('/reauthenticate', authenticateToken, async (req, res, next) => {
    const authReq = req as AuthRequest;
    const validation = reauthenticateSchema.safeParse(req.body);
    if (!validation.success) {
        await auditService.log({
            usuarioId: authReq.user!.id,
            inmobiliariaId: authReq.user!.inmobiliariaId,
            accion: 'REAUTENTICACION_FALLIDA',
            entidad: 'Auth',
            detalle: 'No se proporcionó una contraseña válida',
            severidad: 'WARNING',
            resultado: 'FALLIDO',
            ...getAuditRequestMetadata(authReq)
        });
        return res.status(400).json({ message: 'Contraseña requerida' });
    }
    try {
        const user = await prisma.usuario.findUnique({ where: { id: authReq.user!.id } });
        if (!user || !(await bcrypt.compare(validation.data.password, user.password))) {
            await auditService.log({
                usuarioId: authReq.user!.id,
                inmobiliariaId: authReq.user!.inmobiliariaId,
                accion: 'REAUTENTICACION_FALLIDA',
                entidad: 'Auth',
                detalle: 'La contraseña no coincide',
                severidad: 'WARNING',
                resultado: 'FALLIDO',
                ...getAuditRequestMetadata(authReq)
            });
            return res.status(401).json({ message: 'Contraseña incorrecta' });
        }
        await prisma.userSession.update({ where: { id: authReq.sessionId! }, data: { authenticatedAt: new Date() } });
        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'REAUTENTICACION_EXITOSA',
            entidad: 'Auth',
            ...getAuditRequestMetadata(authReq)
        });
        res.json({ message: 'Identidad confirmada' });
    } catch (error) {
        await auditService.log({
            usuarioId: authReq.user!.id,
            inmobiliariaId: authReq.user!.inmobiliariaId,
            accion: 'REAUTENTICACION_ERROR',
            entidad: 'Auth',
            detalle: 'Error interno durante la confirmación de identidad',
            severidad: 'CRITICAL',
            resultado: 'FALLIDO',
            ...getAuditRequestMetadata(authReq)
        });
        next(error);
    }
});

router.post('/change-password', authenticateToken, async (req, res) => {
    const validation = changePasswordSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ message: 'Datos de entrada inválidos', errors: validation.error.issues.map(issue => issue.message) });
    }
    const id = (req as AuthRequest).user!.id;
    const user = await prisma.usuario.findUnique({ where: { id } });
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (!(await bcrypt.compare(validation.data.currentPassword, user.password))) {
        return res.status(400).json({ message: 'Contraseña actual incorrecta' });
    }
    if (validation.data.newPassword === validation.data.currentPassword) {
        return res.status(400).json({ message: 'La nueva contraseña debe ser diferente de la contraseña temporal' });
    }
    const passwordErrors = validatePasswordStrength(validation.data.newPassword, [user.email, user.nombreCompleto]);
    if (passwordErrors.length) {
        return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
    }

    await prisma.usuario.update({
        where: { id },
        data: {
            password: await bcrypt.hash(validation.data.newPassword, 10),
            sessionVersion: { increment: 1 },
            passwordChangedAt: new Date(),
            mustChangePassword: false
        }
    });
    await revokeAllUserSessions(id);
    clearAuthCookies(res);
    await auditService.log({
        usuarioId: id, inmobiliariaId: user.inmobiliariaId, accion: 'PASSWORD_CHANGE',
        entidad: 'Usuario', entidadId: id, ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'WARNING'
    });
    res.json({ message: 'Contraseña actualizada. Volvé a iniciar sesión.' });
});

router.post('/reset-password/:userId', authenticateToken, requireAdmin, requireRecentAuthentication, async (req, res) => {
    const validation = adminResetSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ message: 'Contraseña temporal inválida', errors: validation.error.issues.map(issue => issue.message) });
    }
    const actor = (req as AuthRequest).user!;
    const userId = Number(req.params.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ message: 'Usuario inválido' });
    if (userId === actor.id) return res.status(400).json({ message: 'Usá la opción de cambiar tu propia contraseña' });

    const user = await prisma.usuario.findFirst({ where: { id: userId, inmobiliariaId: actor.inmobiliariaId } });
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    const passwordErrors = validatePasswordStrength(validation.data.newPassword, [user.email, user.nombreCompleto]);
    if (passwordErrors.length) {
        return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
    }

    await prisma.usuario.update({
        where: { id: user.id },
        data: {
            password: await bcrypt.hash(validation.data.newPassword, 10),
            sessionVersion: { increment: 1 },
            passwordChangedAt: new Date(),
            mustChangePassword: true
        }
    });
    await revokeAllUserSessions(user.id);
    await auditService.log({
        usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId,
        accion: 'PASSWORD_RESET_ADMIN', entidad: 'Usuario', entidadId: user.id,
        detalle: `Contraseña temporal restablecida para ${user.email}`,
        ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
    });
    res.json({ message: 'Contraseña temporal actualizada. El usuario deberá cambiarla al ingresar.' });
});

export default router;
