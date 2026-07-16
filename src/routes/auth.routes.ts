import { Router } from 'express';
import { prisma } from '../prisma';
import bcrypt from 'bcrypt';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { loginLimiter } from '../middlewares/rateLimiter.middleware';
import { z } from 'zod';
import { getUserPermissionDetails, isRoleBelow, userHasPermission } from '../services/permissions.service';
import { auditService } from '../services/audit.service';
import { verifyGoogleIdToken } from '../services/google-auth.service';
import {
    clearAuthCookies,
    createSecureToken,
    createSession,
    getClientIp,
    getUserAgent,
    privilegedRoles,
    revokeAllUserSessions,
    revokeSession,
    sha256,
    validatePasswordStrength
} from '../services/security.service';
import { env } from '../config/env';

const router = Router();

const loginSchema = z.object({
    email: z.string()
        .trim()
        .toLowerCase()
        .email('Email inválido')
        .max(254, 'Email demasiado largo'),
    password: z.string()
        .min(1, 'La contraseña es obligatoria')
        .max(128, 'Contraseña demasiado larga')
});

const googleLoginSchema = z.object({
    idToken: z.string().min(1, 'El token de Google es obligatorio'),
    currentPassword: z.string().max(128).optional()
});

const reauthenticateSchema = z.object({ password: z.string().min(1).max(128) });
const completeResetSchema = z.object({ token: z.string().min(32).max(256), newPassword: z.string().min(12).max(128) });

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida'),
    newPassword: z.string().min(12, 'La nueva contraseña debe tener al menos 12 caracteres').max(128)
});

const resetPasswordSchema = z.object({
    newPassword: z.string().min(12, 'La nueva contraseña debe tener al menos 12 caracteres').max(128)
});

async function buildSessionUser(userId: number) {
    const user = await prisma.usuario.findUnique({
        where: { id: userId },
        include: { inmobiliaria: true }
    });

    if (!user) return null;

    const permissionDetails = await getUserPermissionDetails(user.id, user.rol);

    return {
        id: user.id,
        email: user.email,
        fullName: user.nombreCompleto,
        nombreCompleto: user.nombreCompleto,
        role: user.rol,
        rol: user.rol,
        mustChangePassword: user.mustChangePassword,
        ...permissionDetails,
        inmobiliaria: user.inmobiliaria
    };
}

router.post('/login', loginLimiter, async (req, res) => {
    const validation = loginSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ 
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    const { email, password } = validation.data;

    try {
        const user = await prisma.usuario.findUnique({
            where: { email },
            include: { inmobiliaria: true }
        });

        if (!user || !user.activo) {
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }

        const validPassword = await bcrypt.compare(password, user.password);

        if (!validPassword) {
            await auditService.log({
                usuarioId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                accion: 'LOGIN_FALLIDO',
                entidad: 'Auth',
                detalle: `Intento fallido para ${email}`,
                ipAddress: getClientIp(req),
                userAgent: getUserAgent(req),
                severidad: 'WARNING'
            });
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }

        if (user.rol !== 'SUPERADMIN' && (!user.inmobiliaria || !user.inmobiliaria.activa)) {
            await auditService.log({
                usuarioId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                accion: 'LOGIN_CUENTA_SUSPENDIDA',
                entidad: 'Auth',
                detalle: `Intento de login en cuenta suspendida para ${email}`,
                ipAddress: getClientIp(req),
                userAgent: getUserAgent(req),
                severidad: 'WARNING'
            });
            return res.status(403).json({ message: 'Cuenta suspendida, contacte al administrador' });
        }

        const session = await createSession({
            userId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            sessionVersion: user.sessionVersion,
            req,
            res
        });

        const sessionUser = await buildSessionUser(user.id);

        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'LOGIN_EXITOSO',
            entidad: 'Auth',
            detalle: `Inicio de sesión para ${email}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
            user: sessionUser
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error en el servidor' });
    }
});

router.post('/google', loginLimiter, async (req, res) => {
    const validation = googleLoginSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    try {
        const googleUser = await verifyGoogleIdToken(validation.data.idToken);
        const user = await prisma.usuario.findUnique({
            where: { email: googleUser.email },
            include: { inmobiliaria: true }
        });

        if (!user) {
            return res.status(403).json({
                message: 'No existe una cuenta autorizada para este correo. Comuníquese con el administrador.'
            });
        }

        if (!user.activo) {
            await auditService.log({
                usuarioId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                accion: 'LOGIN_GOOGLE_USUARIO_INACTIVO',
                entidad: 'Auth',
                detalle: `Intento de login con Google en usuario inactivo para ${googleUser.email}`,
                ipAddress: getClientIp(req),
                userAgent: getUserAgent(req),
                severidad: 'WARNING'
            });
            return res.status(401).json({ message: 'Credenciales inválidas' });
        }

        if (user.googleId && user.googleId !== googleUser.googleId) {
            await auditService.log({
                usuarioId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                accion: 'LOGIN_GOOGLE_ID_MISMATCH',
                entidad: 'Auth',
                detalle: `Intento de login con una cuenta Google distinta para ${googleUser.email}`,
                ipAddress: getClientIp(req),
                userAgent: getUserAgent(req),
                severidad: 'CRITICAL'
            });
            return res.status(403).json({ message: 'La cuenta de Google no coincide con el usuario autorizado.' });
        }

        if (user.rol !== 'SUPERADMIN' && (!user.inmobiliaria || !user.inmobiliaria.activa)) {
            await auditService.log({
                usuarioId: user.id,
                inmobiliariaId: user.inmobiliariaId,
                accion: 'LOGIN_CUENTA_SUSPENDIDA',
                entidad: 'Auth',
                detalle: `Intento de login con Google en cuenta suspendida para ${googleUser.email}`,
                ipAddress: getClientIp(req),
                userAgent: getUserAgent(req),
                severidad: 'WARNING'
            });
            return res.status(403).json({ message: 'Cuenta suspendida, contacte al administrador' });
        }

        const googleUserUpdates: { googleId?: string; authProvider?: string; mustChangePassword?: boolean } = {};
        if (!user.googleId) {
            if (!validation.data.currentPassword || !(await bcrypt.compare(validation.data.currentPassword, user.password))) {
                return res.status(403).json({ message: 'Para vincular Google por primera vez, confirmá tu contraseña actual', code: 'GOOGLE_LINK_REQUIRES_PASSWORD' });
            }
            googleUserUpdates.googleId = googleUser.googleId;
            googleUserUpdates.authProvider = user.authProvider === 'LOCAL' ? 'LOCAL_GOOGLE' : user.authProvider;
        }

        if (Object.keys(googleUserUpdates).length > 0) {
            await prisma.usuario.update({
                where: { id: user.id },
                data: googleUserUpdates
            });
        }

        const session = await createSession({
            userId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            sessionVersion: user.sessionVersion,
            req,
            res
        });

        const sessionUser = await buildSessionUser(user.id);

        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'LOGIN_GOOGLE_EXITOSO',
            entidad: 'Auth',
            detalle: `Inicio de sesión con Google para ${googleUser.email}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req)
        });

        res.json({
            csrfToken: session.csrfToken,
            expiresAt: session.expiresAt,
            user: sessionUser
        });
    } catch (error) {
        console.error(error);
        const message = error instanceof Error ? error.message : 'Token de Google inválido';
        if (message === 'GOOGLE_CLIENT_ID no configurado') {
            return res.status(503).json({ message: 'Inicio de sesión con Google no configurado' });
        }
        res.status(401).json({ message: 'No se pudo validar la cuenta de Google' });
    }
});

router.get('/me', authenticateToken, async (req, res) => {
    const { id } = (req as AuthRequest).user!;

    try {
        const sessionUser = await buildSessionUser(id);

        if (!sessionUser) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        res.json({
            ...sessionUser,
            csrfToken: (req as AuthRequest).csrfToken
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener el usuario actual' });
    }
});

router.post('/logout', authenticateToken, async (req, res) => {
    const authReq = req as AuthRequest;
    if (authReq.sessionId) {
        await revokeSession(authReq.sessionId);
    }
    clearAuthCookies(res);
    res.json({ message: 'Sesión cerrada' });
});

router.post('/reauthenticate', authenticateToken, async (req, res) => {
    const validation = reauthenticateSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ message: 'Contraseña requerida' });
    const authReq = req as AuthRequest;
    const user = await prisma.usuario.findUnique({ where: { id: authReq.user!.id } });
    if (!user || !(await bcrypt.compare(validation.data.password, user.password))) return res.status(401).json({ message: 'Contraseña incorrecta' });
    await prisma.userSession.update({ where: { id: authReq.sessionId! }, data: { authenticatedAt: new Date() } });
    res.json({ message: 'Identidad confirmada' });
});

// Change password (logged in user)
router.post('/change-password', authenticateToken, async (req, res) => {
    const validation = changePasswordSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ 
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    const { id } = (req as AuthRequest).user!;
    const { currentPassword, newPassword } = validation.data;

    try {
        const user = await prisma.usuario.findUnique({ where: { id } });
        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) return res.status(400).json({ message: 'Contraseña actual incorrecta' });

        const passwordErrors = validatePasswordStrength(newPassword, [user.email, user.nombreCompleto]);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.usuario.update({
            where: { id },
            data: {
                password: hashedPassword,
                sessionVersion: { increment: 1 },
                passwordChangedAt: new Date(),
                mustChangePassword: false
            }
        });
        await revokeAllUserSessions(id);
        clearAuthCookies(res);

        await auditService.log({
            usuarioId: id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'PASSWORD_CHANGE',
            entidad: 'Usuario',
            entidadId: id,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'WARNING'
        });

        res.json({ message: 'Contraseña actualizada con éxito. Vuelva a iniciar sesión.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al cambiar contraseña' });
    }
});

// Generate a one-time recovery token without choosing the user's password.
router.post('/reset-password/:userId', authenticateToken, requireRecentAuthentication, async (req, res) => {
    const { id: actorId, role, inmobiliariaId } = (req as AuthRequest).user!;
    const { userId } = req.params;

    if (!(await userHasPermission(actorId, role, 'usuarios.editar'))) {
        return res.status(403).json({ message: 'Acceso denegado' });
    }

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(userId), inmobiliariaId }
        });

        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
        if (user.id === actorId || !isRoleBelow(user.rol, role)) return res.status(403).json({ message: 'No podés recuperar una cuenta con rol igual o superior al tuyo' });

        const token = createSecureToken(48);
        await prisma.passwordResetToken.updateMany({ where: { usuarioId: user.id, usedAt: null }, data: { usedAt: new Date() } });
        await prisma.passwordResetToken.create({ data: { tokenHash: sha256(token), expiresAt: new Date(Date.now() + 20 * 60 * 1000), usuarioId: user.id, creadoPorId: actorId } });

        await auditService.log({
            usuarioId: actorId,
            inmobiliariaId,
            accion: 'PASSWORD_RESET_ADMIN',
            entidad: 'Usuario',
            entidadId: Number(userId),
            detalle: `Reset administrativo para ${user.email}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });

        res.json({ message: 'Enlace de recuperación generado. Expira en 20 minutos y puede usarse una sola vez.', resetToken: token });
    } catch (error) {
        res.status(500).json({ message: 'Error al resetear contraseña' });
    }
});

router.post('/complete-password-reset', loginLimiter, async (req, res) => {
    const validation = completeResetSchema.safeParse(req.body);
    if (!validation.success) return res.status(400).json({ message: 'Datos de recuperación inválidos' });
    const record = await prisma.passwordResetToken.findUnique({ where: { tokenHash: sha256(validation.data.token) }, include: { usuario: true } });
    if (!record || record.usedAt || record.expiresAt <= new Date() || !record.usuario.activo) return res.status(400).json({ message: 'El enlace es inválido o expiró' });
    const errors = validatePasswordStrength(validation.data.newPassword, [record.usuario.email, record.usuario.nombreCompleto]);
    if (errors.length) return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors });
    const password = await bcrypt.hash(validation.data.newPassword, 10);
    const consumed = await prisma.$transaction(async tx => {
        const claim = await tx.passwordResetToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
        if (claim.count !== 1) return false;
        await tx.usuario.update({ where: { id: record.usuarioId }, data: { password, sessionVersion: { increment: 1 }, passwordChangedAt: new Date(), mustChangePassword: false } });
        await tx.userSession.updateMany({ where: { usuarioId: record.usuarioId, revokedAt: null }, data: { revokedAt: new Date() } });
        return true;
    });
    if (!consumed) return res.status(400).json({ message: 'El enlace ya fue utilizado' });
    res.json({ message: 'Contraseña actualizada. Ya podés iniciar sesión.' });
});

export default router;
