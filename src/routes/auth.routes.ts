import { Router } from 'express';
import { prisma } from '../prisma';
import bcrypt from 'bcrypt';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { loginLimiter } from '../middlewares/rateLimiter.middleware';
import { z } from 'zod';
import { getUserPermissionDetails, userHasPermission } from '../services/permissions.service';
import { auditService } from '../services/audit.service';
import {
    clearAuthCookies,
    createSession,
    getClientIp,
    getUserAgent,
    privilegedRoles,
    revokeAllUserSessions,
    revokeSession,
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

const changePasswordSchema = z.object({
    currentPassword: z.string().min(1, 'La contraseña actual es requerida'),
    newPassword: z.string().min(12, 'La nueva contraseña debe tener al menos 12 caracteres').max(128)
});

const resetPasswordSchema = z.object({
    newPassword: z.string().min(12, 'La nueva contraseña debe tener al menos 12 caracteres').max(128)
});

const setupSuperAdminSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254, 'Email demasiado largo'),
    password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(128, 'Contraseña demasiado larga'),
    nombreCompleto: z.string().trim().min(2, 'El nombre es obligatorio').max(120, 'Nombre demasiado largo')
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

// Reset password (admin only)
router.post('/reset-password/:userId', authenticateToken, async (req, res) => {
    const validation = resetPasswordSchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({ 
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
        });
    }

    const { id: actorId, role, inmobiliariaId } = (req as AuthRequest).user!;
    const { userId } = req.params;
    const { newPassword } = validation.data;

    if (!(await userHasPermission(actorId, role, 'usuarios.editar'))) {
        return res.status(403).json({ message: 'Acceso denegado' });
    }

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(userId), inmobiliariaId }
        });

        if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

        const passwordErrors = validatePasswordStrength(newPassword, [user.email, user.nombreCompleto]);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await prisma.usuario.update({
            where: { id: Number(userId) },
            data: {
                password: hashedPassword,
                sessionVersion: { increment: 1 },
                passwordChangedAt: new Date(),
                mustChangePassword: true
            }
        });
        await revokeAllUserSessions(Number(userId));

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

        res.json({ message: 'Contraseña reseteada con éxito' });
    } catch (error) {
        res.status(500).json({ message: 'Error al resetear contraseña' });
    }
});

// Setup Initial SuperAdmin (Solo se puede usar si no existe ninguno)
router.post('/setup-superadmin', async (req, res) => {
    try {
        if (env.nodeEnv === 'production' || env.initialSetupToken) {
            const setupToken = req.get('x-setup-token');
            if (!env.initialSetupToken || setupToken !== env.initialSetupToken) {
                return res.status(403).json({ message: 'Token de inicialización inválido' });
            }
        }

        const validation = setupSuperAdminSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({
                message: 'Datos de entrada inválidos',
                errors: validation.error.issues.map((e: z.ZodIssue) => e.message)
            });
        }

        const existingSuperAdmin = await prisma.usuario.findFirst({
            where: { rol: 'SUPERADMIN' }
        });
        
        if (existingSuperAdmin) {
            return res.status(403).json({ message: 'Ya existe un administrador global configurado' });
        }

        const { email, password, nombreCompleto } = validation.data;
        const passwordErrors = validatePasswordStrength(password, [email, nombreCompleto]);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
        }

        // Enlazar al super admin a la primera inmobiliaria existente (Foreign Key)
        // El rol de SUPERADMIN ignora la restricción de inmobiliariaId posteriormente.
        let rootInmo = await prisma.inmobiliaria.findFirst();

        if (!rootInmo) {
            rootInmo = await prisma.inmobiliaria.create({
                data: {
                    nombre: 'SaaS Platform Home',
                    activa: true
                }
            });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const superAdmin = await prisma.usuario.create({
            data: {
                email,
                password: hashedPassword,
                nombreCompleto,
                rol: 'SUPERADMIN',
                inmobiliariaId: rootInmo.id,
                mustChangePassword: false
            }
        });
        
        res.status(201).json({ 
            message: 'Super Administrador inicializado con éxito', 
            email: superAdmin.email 
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error crítico de inicialización' });
    }
});

export default router;
