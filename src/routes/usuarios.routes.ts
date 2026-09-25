import { Router } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { acquireInstallationLock, INSTALLATION_LOCKS } from '../utils/advisory-lock';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import { validateBody, requiredText } from '../middlewares/validation.middleware';
import { MODULE_PERMISSIONS } from '../services/permissions.service';
import { auditService } from '../services/audit.service';
import { getClientIp, getUserAgent, revokeAllUserSessions, validatePasswordStrength } from '../services/security.service';
import { withPagination } from '../middlewares/pagination.middleware';

const router = Router();
router.use(authenticateToken, requireAdmin);

const createUserSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254),
    password: z.string().min(12, 'La contraseña debe tener al menos 12 caracteres').max(128),
    nombreCompleto: requiredText('El nombre completo', 120),
    tipo: z.enum(['ADMIN', 'USUARIO']).default('USUARIO'),
    rolId: z.number().int().positive().nullable().optional()
}).strict().superRefine((data, ctx) => {
    if (data.tipo === 'USUARIO' && !data.rolId) ctx.addIssue({ code: 'custom', path: ['rolId'], message: 'El rol es obligatorio para usuarios comunes' });
    if (data.tipo === 'ADMIN' && data.rolId) ctx.addIssue({ code: 'custom', path: ['rolId'], message: 'El Administrador no utiliza un rol' });
});

const updateUserSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254).optional(),
    nombreCompleto: requiredText('El nombre completo', 120).optional(),
    tipo: z.enum(['ADMIN', 'USUARIO']).optional(),
    rolId: z.number().int().positive().nullable().optional(),
    activo: z.boolean().optional()
}).strict().refine(data => Object.keys(data).length > 0, { message: 'Debe indicar al menos un campo para actualizar' });

const userSelect = {
    id: true,
    email: true,
    nombreCompleto: true,
    tipo: true,
    activo: true,
    mustChangePassword: true,
    ultimoAcceso: true,
    fechaCreacion: true,
    fechaActualizacion: true,
    rol: { select: { id: true, nombre: true, activo: true } }
} satisfies Prisma.UsuarioSelect;

type UserRow = Prisma.UsuarioGetPayload<{ select: typeof userSelect }>;

const serializeUser = (user: UserRow) => ({
    ...user,
    fullName: user.nombreCompleto,
    role: user.tipo,
    permissions: user.tipo === 'ADMIN' ? [...MODULE_PERMISSIONS] : undefined
});

async function validateRole(rolId: number | null | undefined, inmobiliariaId: number) {
    if (!rolId) return null;
    return prisma.rol.findFirst({ where: { id: rolId, inmobiliariaId, activo: true }, select: { id: true, nombre: true, activo: true } });
}

router.get('/', withPagination(25), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const pagination = res.locals.pagination;
    const search = String(req.query.search || '').trim();
    const where = {
        inmobiliariaId,
        ...(search ? { OR: [
            { nombreCompleto: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } }
        ] } : {})
    };
    const [total, users] = await prisma.$transaction([
        prisma.usuario.count({ where }),
        prisma.usuario.findMany({ where, select: userSelect, orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }], skip: pagination.skip, take: pagination.limit })
    ]);
    res.json({
        data: users.map(serializeUser),
        meta: { total, page: pagination.page, limit: pagination.limit, totalPages: Math.ceil(total / pagination.limit) }
    });
});

router.get('/opciones', async (req, res) => {
    const users = await prisma.usuario.findMany({
        where: { inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId, activo: true },
        select: userSelect,
        orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }]
    });
    res.json(users.map(serializeUser));
});

router.get('/permisos/catalogo', async (_req, res) => {
    const permisos = await prisma.permiso.findMany({
        where: { clave: { in: [...MODULE_PERMISSIONS] } },
        orderBy: [{ modulo: 'asc' }, { accion: 'asc' }]
    });
    res.json(permisos);
});

router.post('/', requireRecentAuthentication, validateBody(createUserSchema), async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const { email, password, nombreCompleto, tipo, rolId } = req.body;
    const passwordErrors = validatePasswordStrength(password, [email, nombreCompleto]);
    if (passwordErrors.length) return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
    if (await prisma.usuario.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } })) {
        return res.status(409).json({ message: 'El email ya está en uso' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    let created;
    try {
        created = await prisma.$transaction(async tx => {
            await acquireInstallationLock(tx, INSTALLATION_LOCKS.usersAndRoles, actor.inmobiliariaId);
            if (tipo === 'USUARIO') {
                const role = await tx.rol.findFirst({ where: { id: rolId, inmobiliariaId: actor.inmobiliariaId, activo: true } });
                if (!role) throw new Error('ROLE_INACTIVE');
            }
            return tx.usuario.create({
                data: { email, password: passwordHash, nombreCompleto, tipo, rolId: tipo === 'USUARIO' ? rolId : null, inmobiliariaId: actor.inmobiliariaId, mustChangePassword: true },
                select: userSelect
            });
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'ROLE_INACTIVE') return res.status(400).json({ message: 'El rol seleccionado no existe o está deshabilitado' });
        throw error;
    }
    await auditService.log({
        usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId,
        accion: 'CREAR_USUARIO', entidad: 'Usuario', entidadId: created.id,
        detalle: JSON.stringify({ email: created.email, tipo: created.tipo, rolId: created.rol?.id || null }),
        ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: created.tipo === 'ADMIN' ? 'CRITICAL' : 'INFO'
    });
    res.status(201).json(serializeUser(created));
});

router.put('/:id', requireRecentAuthentication, validateBody(updateUserSchema), async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ message: 'Usuario inválido' });

    const current = await prisma.usuario.findFirst({ where: { id: userId, inmobiliariaId: actor.inmobiliariaId }, include: { rol: true } });
    if (!current) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (current.id === actor.id && (req.body.tipo !== undefined || req.body.rolId !== undefined || req.body.activo === false)) {
        return res.status(400).json({ message: 'No podés cambiar tu propio tipo, rol ni deshabilitar tu cuenta' });
    }

    const nextType = req.body.tipo ?? current.tipo;
    const nextRoleId = nextType === 'ADMIN' ? null : (req.body.rolId !== undefined ? req.body.rolId : current.rolId);
    if (nextType === 'USUARIO' && !(await validateRole(nextRoleId, actor.inmobiliariaId))) {
        return res.status(400).json({ message: 'El usuario común debe tener un rol activo de esta instalación' });
    }
    if (req.body.email && await prisma.usuario.findFirst({
        where: { id: { not: current.id }, email: { equals: req.body.email, mode: 'insensitive' } }
    })) return res.status(409).json({ message: 'El email ya está en uso' });

    const securityChanged = nextType !== current.tipo || nextRoleId !== current.rolId || req.body.activo !== undefined;
    try {
        const updated = await prisma.$transaction(async tx => {
            await acquireInstallationLock(tx, INSTALLATION_LOCKS.activeAdministrator, actor.inmobiliariaId);
            await acquireInstallationLock(tx, INSTALLATION_LOCKS.usersAndRoles, actor.inmobiliariaId);
            if (nextType === 'USUARIO') {
                const role = await tx.rol.findFirst({ where: { id: nextRoleId!, inmobiliariaId: actor.inmobiliariaId, activo: true } });
                if (!role) throw new Error('ROLE_INACTIVE');
            }
            return tx.usuario.update({
                where: { id: current.id },
                data: {
                    email: req.body.email,
                    nombreCompleto: req.body.nombreCompleto,
                    tipo: nextType,
                    rolId: nextRoleId,
                    activo: req.body.activo,
                    ...(securityChanged ? { sessionVersion: { increment: 1 } } : {})
                },
                select: userSelect
            });
        });
        if (securityChanged) await revokeAllUserSessions(current.id);
        await auditService.log({
            usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId,
            accion: 'ACTUALIZAR_USUARIO', entidad: 'Usuario', entidadId: current.id,
            detalle: JSON.stringify({ antes: { email: current.email, tipo: current.tipo, rolId: current.rolId, activo: current.activo }, despues: { email: updated.email, tipo: updated.tipo, rolId: updated.rol?.id || null, activo: updated.activo } }),
            ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: securityChanged ? 'CRITICAL' : 'INFO'
        });
        res.json(serializeUser(updated));
    } catch (error) {
        const lastAdmin = error instanceof Error && error.message.includes('administrador activo');
        const inactiveRole = error instanceof Error && error.message === 'ROLE_INACTIVE';
        const message = lastAdmin ? 'No se puede dejar la instalación sin un Administrador activo' : inactiveRole ? 'El rol seleccionado ya no está disponible' : 'No se pudo actualizar el usuario';
        res.status(lastAdmin ? 409 : inactiveRole ? 400 : 500).json({ message });
    }
});

router.delete('/:id', requireRecentAuthentication, async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const userId = Number(req.params.id);
    if (!Number.isSafeInteger(userId) || userId <= 0) return res.status(400).json({ message: 'Usuario inválido' });
    if (userId === actor.id) return res.status(400).json({ message: 'No podés deshabilitar tu propio usuario' });
    const user = await prisma.usuario.findFirst({ where: { id: userId, inmobiliariaId: actor.inmobiliariaId } });
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    if (!user.activo) return res.status(204).send();

    try {
        await prisma.$transaction(async tx => {
            await acquireInstallationLock(tx, INSTALLATION_LOCKS.activeAdministrator, actor.inmobiliariaId);
            await tx.usuario.update({ where: { id: user.id }, data: { activo: false, sessionVersion: { increment: 1 } } });
        });
        await revokeAllUserSessions(user.id);
        await auditService.log({
            usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId,
            accion: 'DESHABILITAR_USUARIO', entidad: 'Usuario', entidadId: user.id,
            detalle: user.email, ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
        });
        res.status(204).send();
    } catch (error) {
        const lastAdmin = error instanceof Error && error.message.includes('administrador activo');
        res.status(lastAdmin ? 409 : 500).json({ message: lastAdmin ? 'No se puede deshabilitar al último Administrador activo' : 'No se pudo deshabilitar el usuario' });
    }
});

export default router;
