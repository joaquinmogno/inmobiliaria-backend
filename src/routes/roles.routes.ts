import { Router } from 'express';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { acquireInstallationLock, INSTALLATION_LOCKS } from '../utils/advisory-lock';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import { validateBody, requiredText } from '../middlewares/validation.middleware';
import {
    ROLE_ASSIGNABLE_PERMISSIONS,
    ROLE_PERMISSION_CAPABILITIES,
    getMissingPermissionDependencies
} from '../services/permissions.service';
import { auditService } from '../services/audit.service';
import { getClientIp, getUserAgent, revokeAllUserSessions } from '../services/security.service';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate, optimisticVersionSchema } from '../utils/optimistic-lock';

const router = Router();
router.use(authenticateToken, requireAdmin);

const roleSchema = z.object({
    nombre: requiredText('El nombre', 80),
    descripcion: z.string().trim().max(240).nullable().optional(),
    permisos: z.array(z.enum([...ROLE_ASSIGNABLE_PERMISSIONS] as [string, ...string[]])).default([])
}).strict();
const roleUpdateSchema = roleSchema.partial().extend({
    activo: z.boolean().optional(),
    version: optimisticVersionSchema
}).refine(
    data => Object.keys(data).some(key => key !== 'version'),
    { message: 'Debe indicar al menos un campo para actualizar' }
);

const roleInclude = {
    permisos: { select: { permiso: { select: { id: true, clave: true, descripcion: true, modulo: true, accion: true } } } },
    _count: { select: { usuarios: true } }
} satisfies Prisma.RolInclude;

type RoleRow = Prisma.RolGetPayload<{ include: typeof roleInclude }>;

const serializeRole = (role: RoleRow) => ({
    id: role.id,
    version: role.version,
    nombre: role.nombre,
    descripcion: role.descripcion,
    activo: role.activo,
    fechaCreacion: role.fechaCreacion,
    fechaActualizacion: role.fechaActualizacion,
    cantidadUsuarios: role._count?.usuarios ?? 0,
    permisos: role.permisos
        .filter(item => ROLE_ASSIGNABLE_PERMISSIONS.includes(item.permiso.clave as typeof ROLE_ASSIGNABLE_PERMISSIONS[number]))
        .map(item => item.permiso)
});

async function resolvePermissions(keys: string[]) {
    const uniqueKeys = [...new Set(keys)];
    if (getMissingPermissionDependencies(uniqueKeys).length) throw new Error('PERMISSION_DEPENDENCY');
    const permissions = await prisma.permiso.findMany({ where: { clave: { in: uniqueKeys } }, select: { id: true, clave: true } });
    if (permissions.length !== uniqueKeys.length) throw new Error('INVALID_PERMISSION');
    return permissions;
}

router.get('/', async (req, res) => {
    const roles = await prisma.rol.findMany({
        where: { inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId },
        include: roleInclude,
        orderBy: [{ activo: 'desc' }, { nombre: 'asc' }]
    });
    res.json(roles.map(serializeRole));
});

router.get('/catalogo-permisos', async (_req, res) => {
    const permissions = await prisma.permiso.findMany({
        where: { clave: { in: [...ROLE_ASSIGNABLE_PERMISSIONS] } }
    });
    const permissionsByKey = new Map(permissions.map(permission => [permission.clave, permission]));
    res.json(ROLE_PERMISSION_CAPABILITIES.flatMap(capability => {
        const permission = permissionsByKey.get(capability.key);
        if (!permission) return [];
        return [{
            ...permission,
            descripcion: capability.label,
            etiqueta: capability.label,
            grupo: capability.group,
            requiere: [...capability.requires],
            ruta: capability.route,
            control: capability.control
        }];
    }));
});

router.get('/:id/usuarios', async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const roleId = Number(req.params.id);
    const role = await prisma.rol.findFirst({ where: { id: roleId, inmobiliariaId: actor.inmobiliariaId } });
    if (!role) return res.status(404).json({ message: 'Rol no encontrado' });
    const users = await prisma.usuario.findMany({
        where: { rolId: role.id },
        select: { id: true, nombreCompleto: true, email: true, activo: true },
        orderBy: { nombreCompleto: 'asc' }
    });
    res.json(users);
});

router.post('/', requireRecentAuthentication, validateBody(roleSchema), async (req, res) => {
    const actor = (req as AuthRequest).user!;
    try {
        const permissions = await resolvePermissions(req.body.permisos);
        const duplicate = await prisma.rol.findFirst({ where: { inmobiliariaId: actor.inmobiliariaId, nombre: { equals: req.body.nombre, mode: 'insensitive' } } });
        if (duplicate) return res.status(409).json({ message: 'Ya existe un rol con ese nombre' });
        const role = await prisma.rol.create({
            data: {
                nombre: req.body.nombre,
                descripcion: req.body.descripcion || null,
                inmobiliariaId: actor.inmobiliariaId,
                permisos: { create: permissions.map(permission => ({ permisoId: permission.id })) }
            },
            include: roleInclude
        });
        await auditService.log({
            usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId, accion: 'CREAR_ROL',
            entidad: 'Rol', entidadId: role.id,
            detalle: JSON.stringify({ nombre: role.nombre, permisos: req.body.permisos }),
            ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
        });
        res.status(201).json(serializeRole(role));
    } catch (error) {
        const message = error instanceof Error && error.message === 'PERMISSION_DEPENDENCY'
            ? 'Para crear, editar o eliminar en un módulo también debe habilitar el permiso de verlo'
            : 'Uno o más permisos no son válidos';
        res.status(400).json({ message });
    }
});

router.put('/:id', requireRecentAuthentication, validateBody(roleUpdateSchema), async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const roleId = Number(req.params.id);
    if (!Number.isSafeInteger(roleId) || roleId <= 0) return res.status(400).json({ message: 'Rol inválido' });
    const current = await prisma.rol.findFirst({ where: { id: roleId, inmobiliariaId: actor.inmobiliariaId }, include: roleInclude });
    if (!current) return res.status(404).json({ message: 'Rol no encontrado' });
    if (req.body.nombre) {
        const duplicate = await prisma.rol.findFirst({ where: { id: { not: roleId }, inmobiliariaId: actor.inmobiliariaId, nombre: { equals: req.body.nombre, mode: 'insensitive' } } });
        if (duplicate) return res.status(409).json({ message: 'Ya existe un rol con ese nombre' });
    }
    if (req.body.activo === false && current._count.usuarios > 0) {
        return res.status(409).json({ message: 'No se puede deshabilitar un rol asignado a usuarios' });
    }

    try {
        if (current.version !== req.body.version) {
            assertOptimisticUpdate(0, req.body.version, current.version);
        }
        const permissions = req.body.permisos ? await resolvePermissions(req.body.permisos) : null;
        const updated = await prisma.$transaction(async tx => {
            await acquireInstallationLock(tx, INSTALLATION_LOCKS.usersAndRoles, actor.inmobiliariaId);
            if (req.body.activo === false && await tx.usuario.count({ where: { rolId: roleId } })) throw new Error('ROLE_IN_USE');
            const claim = await tx.rol.updateMany({
                where: { id: roleId, inmobiliariaId: actor.inmobiliariaId, version: req.body.version },
                data: {
                    nombre: req.body.nombre,
                    descripcion: req.body.descripcion,
                    activo: req.body.activo,
                    version: { increment: 1 }
                }
            });
            const currentVersion = claim.count === 0
                ? (await tx.rol.findFirst({ where: { id: roleId, inmobiliariaId: actor.inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(claim.count, req.body.version, currentVersion);
            if (permissions) {
                await tx.rolPermiso.deleteMany({ where: { rolId: roleId } });
                if (permissions.length) await tx.rolPermiso.createMany({ data: permissions.map(permission => ({ rolId: roleId, permisoId: permission.id })) });
            }
            if (permissions) await tx.usuario.updateMany({ where: { rolId: roleId }, data: { sessionVersion: { increment: 1 } } });
            return tx.rol.findUniqueOrThrow({ where: { id: roleId }, include: roleInclude });
        });
        if (permissions) {
            const users = await prisma.usuario.findMany({ where: { rolId: roleId }, select: { id: true } });
            await Promise.all(users.map(user => revokeAllUserSessions(user.id)));
        }
        await auditService.log({
            usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId, accion: 'ACTUALIZAR_ROL',
            entidad: 'Rol', entidadId: roleId,
            detalle: JSON.stringify({ nombre: updated.nombre, activo: updated.activo, permisos: req.body.permisos }),
            ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL'
        });
        res.json(serializeRole(updated));
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        const dependency = error instanceof Error && error.message === 'PERMISSION_DEPENDENCY';
        const inUse = error instanceof Error && error.message === 'ROLE_IN_USE';
        res.status(inUse ? 409 : 400).json({ message: dependency ? 'Las acciones requieren también el permiso de ver el módulo' : inUse ? 'No se puede deshabilitar un rol asignado a usuarios' : 'No se pudo actualizar el rol' });
    }
});

router.post('/:id/duplicar', requireRecentAuthentication, async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const roleId = Number(req.params.id);
    const source = await prisma.rol.findFirst({ where: { id: roleId, inmobiliariaId: actor.inmobiliariaId }, include: roleInclude });
    if (!source) return res.status(404).json({ message: 'Rol no encontrado' });
    let suffix = 1;
    let name = `Copia de ${source.nombre}`;
    while (await prisma.rol.findFirst({ where: { inmobiliariaId: actor.inmobiliariaId, nombre: name } })) name = `Copia ${++suffix} de ${source.nombre}`;
    const duplicated = await prisma.rol.create({
        data: {
            nombre: name,
            descripcion: source.descripcion,
            inmobiliariaId: actor.inmobiliariaId,
            permisos: {
                create: source.permisos
                    .filter(item => ROLE_ASSIGNABLE_PERMISSIONS.includes(item.permiso.clave as typeof ROLE_ASSIGNABLE_PERMISSIONS[number]))
                    .map(item => ({ permisoId: item.permiso.id }))
            }
        },
        include: roleInclude
    });
    await auditService.log({ usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId, accion: 'DUPLICAR_ROL', entidad: 'Rol', entidadId: duplicated.id, detalle: `Origen: ${source.id}`, ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'WARNING' });
    res.status(201).json(serializeRole(duplicated));
});

router.delete('/:id', requireRecentAuthentication, async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const roleId = Number(req.params.id);
    const role = await prisma.rol.findFirst({ where: { id: roleId, inmobiliariaId: actor.inmobiliariaId }, include: { _count: { select: { usuarios: true } } } });
    if (!role) return res.status(404).json({ message: 'Rol no encontrado' });
    if (role._count.usuarios > 0) return res.status(409).json({ message: 'No se puede eliminar un rol que fue asignado a usuarios' });
    try {
        await prisma.$transaction(async tx => {
            await acquireInstallationLock(tx, INSTALLATION_LOCKS.usersAndRoles, actor.inmobiliariaId);
            if (await tx.usuario.count({ where: { rolId: role.id } })) throw new Error('ROLE_IN_USE');
            await tx.rol.delete({ where: { id: role.id } });
        });
    } catch (error) {
        if (error instanceof Error && error.message === 'ROLE_IN_USE') return res.status(409).json({ message: 'No se puede eliminar un rol asignado a usuarios' });
        throw error;
    }
    await auditService.log({ usuarioId: actor.id, inmobiliariaId: actor.inmobiliariaId, accion: 'ELIMINAR_ROL', entidad: 'Rol', entidadId: role.id, detalle: role.nombre, ipAddress: getClientIp(req), userAgent: getUserAgent(req), severidad: 'CRITICAL' });
    res.status(204).send();
});

export default router;
