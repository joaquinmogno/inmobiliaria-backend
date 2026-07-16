import { Router } from 'express';
import { parsePagination } from '../utils/pagination';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { validateBody, requiredText } from '../middlewares/validation.middleware';
import { canCreateRole, getUserPermissionDetails, getUserPermissions, isRoleBelow, MODULE_PERMISSIONS, resolveEffectivePermissions, userHasPermission } from '../services/permissions.service';
import { auditService } from '../services/audit.service';
import { getClientIp, getUserAgent, privilegedRoles, revokeAllUserSessions, validatePasswordStrength } from '../services/security.service';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { createUserWithPermissions } from '../services/users.service';

const router = Router();

router.use(authenticateToken);

const createUserSchema = z.object({
    email: z.string().trim().toLowerCase().email('Email inválido').max(254),
    password: z.string().min(12, 'La contraseña debe tener al menos 12 caracteres').max(128),
    nombreCompleto: requiredText('El nombre completo', 120),
    rol: z.enum(['OWNER', 'JEFE', 'ADMIN', 'AGENTE']).optional().default('AGENTE'),
    permissions: z.array(z.enum(MODULE_PERMISSIONS)).optional().default([]),
    deniedPermissions: z.array(z.enum(MODULE_PERMISSIONS)).optional().default([])
});

const updateUserSchema = createUserSchema.omit({ password: true, permissions: true, deniedPermissions: true }).extend({
    activo: z.boolean().optional()
}).partial().refine(
    data => Object.keys(data).length > 0,
    { message: 'Debe indicar al menos un campo para actualizar' }
);

const updatePermissionsSchema = z.object({
    permissions: z.array(z.enum(MODULE_PERMISSIONS)).default([]),
    deniedPermissions: z.array(z.enum(MODULE_PERMISSIONS)).default([])
});

// Get all users of the agency
async function otherUserCanManagePermissions(inmobiliariaId: number, excludedUserId: number) {
    const users = await prisma.usuario.findMany({
        where: { inmobiliariaId, id: { not: excludedUserId } },
        select: { id: true, rol: true }
    });

    for (const user of users) {
        const permissions = await getUserPermissions(user.id, user.rol);
        if (permissions.includes('usuarios.permisos')) return true;
    }

    return false;
}

async function assertDoesNotRemoveLastPermissionManager(
    inmobiliariaId: number,
    targetUserId: number,
    projectedPermissions: string[],
    res: any
) {
    if (projectedPermissions.includes('usuarios.permisos')) return true;
    if (await otherUserCanManagePermissions(inmobiliariaId, targetUserId)) return true;

    res.status(400).json({
        message: 'No se puede dejar a la inmobiliaria sin un usuario con permiso para administrar permisos'
    });
    return false;
}

router.get('/', requirePermission('usuarios.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const pagination = parsePagination(req.query.page, req.query.limit, 25);
    const search = String(req.query.search || '').trim();
    try {
        const where = { inmobiliariaId, ...(search ? { OR: [
            { nombreCompleto: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } }
        ] } : {}) };
        const [total, users] = await prisma.$transaction([
          prisma.usuario.count({ where }),
          prisma.usuario.findMany({
            where,
            select: {
                id: true,
                email: true,
                nombreCompleto: true,
                rol: true,
                activo: true,
                mustChangePassword: true,
                fechaCreacion: true,
                fechaActualizacion: true,
                permisos: {
                    select: {
                        permiso: {
                            select: {
                                clave: true
                            }
                        }
                    }
                },
                permisosDenegados: {
                    select: {
                        permiso: {
                            select: {
                                clave: true
                            }
                        }
                    }
                }
            },
            orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }],
            skip: pagination.skip,
            take: pagination.limit
          })
        ]);

        const roles = [...new Set(users.map(user => user.rol))];
        const rolePermissionRows = await prisma.rolPermiso.findMany({
            where: { rol: { in: roles } },
            select: { rol: true, permiso: { select: { clave: true } } }
        });
        const permissionsByRole = new Map<string, string[]>();
        rolePermissionRows.forEach(row => permissionsByRole.set(row.rol, [...(permissionsByRole.get(row.rol) || []), row.permiso.clave]));

        const usersWithPermissions = users.map(user => {
            const inheritedPermissions = permissionsByRole.get(user.rol) || [];
            const directPermissions = user.permisos.map(item => item.permiso.clave);
            const deniedPermissions = user.permisosDenegados.map(item => item.permiso.clave);
            return {
                id: user.id,
                email: user.email,
                fullName: user.nombreCompleto,
                nombreCompleto: user.nombreCompleto,
                role: user.rol,
                rol: user.rol,
                fechaCreacion: user.fechaCreacion,
                fechaActualizacion: user.fechaActualizacion,
                activo: user.activo,
                mustChangePassword: user.mustChangePassword,
                inheritedPermissions,
                directPermissions,
                deniedPermissions,
                permissions: resolveEffectivePermissions(inheritedPermissions, directPermissions, deniedPermissions)
            };
        });

        res.json({ data: usersWithPermissions, meta: { total, page: pagination.page, limit: pagination.limit, totalPages: Math.ceil(total / pagination.limit) } });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener usuarios' });
    }
});

router.get('/opciones', requirePermission('usuarios.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const users = await prisma.usuario.findMany({
        where: { inmobiliariaId, activo: true },
        select: { id: true, email: true, nombreCompleto: true, rol: true },
        orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }]
    });
    res.json(users.map(user => ({ ...user, fullName: user.nombreCompleto, role: user.rol })));
});

router.get('/permisos/catalogo', requirePermission('usuarios.permisos'), async (_req, res) => {
    try {
        const permisos = await prisma.permiso.findMany({
            where: { clave: { in: [...MODULE_PERMISSIONS] } },
            orderBy: { clave: 'asc' }
        });

        res.json(permisos);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener permisos' });
    }
});

// Create user
router.post('/', requirePermission('usuarios.crear'), requireRecentAuthentication, validateBody(createUserSchema), async (req, res) => {
    const { inmobiliariaId, role: actorRole, id: actorId } = (req as AuthRequest).user!;
    const { email, password, nombreCompleto, rol, permissions, deniedPermissions } = req.body;

    try {
        if (!canCreateRole(actorRole, rol)) return res.status(403).json({ message: 'No podés crear un usuario con un rol igual o superior al tuyo' });
        if (rol !== 'AGENTE' && !(await userHasPermission(actorId, actorRole, 'usuarios.asignar_rol'))) {
            return res.status(403).json({ message: 'No tenés permiso para asignar roles' });
        }
        const passwordErrors = validatePasswordStrength(password, [email, nombreCompleto]);
        if (passwordErrors.length > 0) {
            return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
        }

        const existingUser = await prisma.usuario.findUnique({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: 'El email ya está en uso' });
        }

        const requestedKeys = [...new Set<string>([...permissions, ...deniedPermissions])];
        const catalog = requestedKeys.length ? await prisma.permiso.findMany({ where: { clave: { in: requestedKeys } } }) : [];
        if (catalog.length !== requestedKeys.length) return res.status(400).json({ message: 'Uno o más permisos no existen' });
        const hashedPassword = await bcrypt.hash(password, 10);

        const user = await createUserWithPermissions({ email, hashedPassword, nombreCompleto, rol: rol || 'AGENTE', inmobiliariaId, permissions, deniedPermissions, catalog });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_USUARIO',
            entidad: 'Usuario',
            entidadId: user.id,
            detalle: `Usuario creado: ${user.email}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: privilegedRoles.has(user.rol) ? 'CRITICAL' : 'INFO'
        });

        const { password: _, nombreCompleto: fullName, rol: role, ...userWithoutPassword } = user;
        res.status(201).json({
            ...userWithoutPassword,
            nombreCompleto: fullName,
            fullName,
            rol: role,
            role,
            ...(await getUserPermissionDetails(user.id, role)),
            directPermissions: permissions,
            deniedPermissions
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al crear usuario' });
    }
});

router.put('/:id/permisos', requirePermission('usuarios.permisos'), requireRecentAuthentication, validateBody(updatePermissionsSchema), async (req, res) => {
    const { id: actorId, inmobiliariaId, role: actorRole } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { permissions, deniedPermissions } = req.body as { permissions: string[]; deniedPermissions: string[] };

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }
        if (user.id === actorId || !isRoleBelow(user.rol, actorRole)) {
            return res.status(403).json({ message: 'No podés modificar tus propios permisos ni los de un rol igual o superior' });
        }

        const before = await getUserPermissionDetails(user.id, user.rol);

        const permisos = await prisma.permiso.findMany({
            where: { clave: { in: [...permissions, ...deniedPermissions] } }
        });

        const requestedPermissionCount = new Set([...permissions, ...deniedPermissions]).size;
        if (permisos.length !== requestedPermissionCount) {
            return res.status(400).json({ message: 'Uno o más permisos no existen' });
        }
        const directSet = new Set(permissions);
        const deniedSet = new Set(deniedPermissions);
        const directPermisos = permisos.filter(permiso => directSet.has(permiso.clave));
        const deniedPermisos = permisos.filter(permiso => deniedSet.has(permiso.clave));
        const rolePermissions = before.inheritedPermissions;
        const projectedPermissions = resolveEffectivePermissions(rolePermissions, permissions, deniedPermissions);

        if (!(await assertDoesNotRemoveLastPermissionManager(inmobiliariaId, user.id, projectedPermissions, res))) {
            return;
        }

        await prisma.$transaction(async tx => {
            await tx.usuarioPermiso.deleteMany({ where: { usuarioId: user.id } });
            await tx.usuarioPermisoDenegado.deleteMany({ where: { usuarioId: user.id } });

            if (directPermisos.length > 0) {
                await tx.usuarioPermiso.createMany({
                    data: directPermisos.map(permiso => ({
                        usuarioId: user.id,
                        permisoId: permiso.id
                    })),
                    skipDuplicates: true
                });
            }

            if (deniedPermisos.length > 0) {
                await tx.usuarioPermisoDenegado.createMany({
                    data: deniedPermisos.map(permiso => ({
                        usuarioId: user.id,
                        permisoId: permiso.id
                    })),
                    skipDuplicates: true
                });
            }
        });

        const beforeDirectSet = new Set(before.directPermissions);
        const beforeDeniedSet = new Set(before.deniedPermissions);
        const afterDirectSet = new Set(permissions);
        const afterDeniedSet = new Set(deniedPermissions);
        const permisosAgregados = permissions.filter(permission => !beforeDirectSet.has(permission));
        const permisosQuitados = before.directPermissions.filter(permission => !afterDirectSet.has(permission));
        const denegacionesAgregadas = deniedPermissions.filter(permission => !beforeDeniedSet.has(permission));
        const denegacionesQuitadas = before.deniedPermissions.filter(permission => !afterDeniedSet.has(permission));

        await auditService.log({
            usuarioId: actorId,
            inmobiliariaId,
            accion: 'CAMBIAR_PERMISOS_USUARIO',
            entidad: 'Usuario',
            entidadId: user.id,
            detalle: JSON.stringify({
                usuarioAfectado: user.email,
                cambiadoPorUsuarioId: actorId,
                permisosAntes: before.permissions,
                permisosDirectosAntes: before.directPermissions,
                permisosDenegadosAntes: before.deniedPermissions,
                permisosAgregados,
                permisosQuitados,
                denegacionesAgregadas,
                denegacionesQuitadas,
                permisosDirectosDespues: permissions,
                permisosDenegadosDespues: deniedPermissions,
                permisosEfectivosDespues: projectedPermissions
            }),
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });
        await revokeAllUserSessions(user.id);

        res.json({
            id: user.id,
            ...(await getUserPermissionDetails(user.id, user.rol))
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar permisos' });
    }
});

// Update user
router.put('/:id', requirePermission('usuarios.editar'), requireRecentAuthentication, validateBody(updateUserSchema), async (req, res) => {
    const { inmobiliariaId, id: actorId, role: actorRole } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { email, nombreCompleto, rol, activo } = req.body;

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        const changesPrivilege = Boolean(rol && rol !== user.rol) || activo === false;
        if (user.id !== actorId && !isRoleBelow(user.rol, actorRole)) return res.status(403).json({ message: 'No podés modificar un usuario con rol igual o superior al tuyo' });
        if (user.id === actorId && changesPrivilege) return res.status(403).json({ message: 'No podés cambiar tu propio rol ni desactivar tu cuenta' });
        if (rol && rol !== user.rol) {
            if (!(await userHasPermission(actorId, actorRole, 'usuarios.asignar_rol'))) return res.status(403).json({ message: 'No tenés permiso para asignar roles' });
            if (!isRoleBelow(rol, actorRole)) return res.status(403).json({ message: 'No podés asignar un rol igual o superior al tuyo' });
        }

        if (rol && rol !== user.rol) {
            const rolePermissions = await prisma.rolPermiso.findMany({
                where: { rol },
                select: { permiso: { select: { clave: true } } }
            });
            const directPermissions = await prisma.usuarioPermiso.findMany({
                where: { usuarioId: user.id },
                select: { permiso: { select: { clave: true } } }
            });
            const deniedPermissions = await prisma.usuarioPermisoDenegado.findMany({
                where: { usuarioId: user.id },
                select: { permiso: { select: { clave: true } } }
            });
            const projectedPermissions = resolveEffectivePermissions(
                rolePermissions.map(item => item.permiso.clave),
                directPermissions.map(item => item.permiso.clave),
                deniedPermissions.map(item => item.permiso.clave)
            );

            if (!(await assertDoesNotRemoveLastPermissionManager(inmobiliariaId, user.id, projectedPermissions, res))) {
                return;
            }
        }

        const updatedUser = await prisma.usuario.update({
            where: { id: Number(id) },
            data: {
                email,
                nombreCompleto,
                rol,
                activo,
                ...(rol && rol !== user.rol ? { sessionVersion: { increment: 1 } } : {}),
                ...(activo === false ? { sessionVersion: { increment: 1 } } : {})
            }
        });
        if ((rol && rol !== user.rol) || activo === false) {
            await revokeAllUserSessions(user.id);
        }

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_USUARIO',
            entidad: 'Usuario',
            entidadId: updatedUser.id,
            detalle: `Usuario actualizado: ${updatedUser.email}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: rol && rol !== user.rol ? 'CRITICAL' : 'WARNING'
        });

        const directPermissions = await prisma.usuarioPermiso.findMany({
            where: { usuarioId: updatedUser.id },
            select: { permiso: { select: { clave: true } } }
        });
        const deniedPermissions = await prisma.usuarioPermisoDenegado.findMany({
            where: { usuarioId: updatedUser.id },
            select: { permiso: { select: { clave: true } } }
        });

        const { password: _, nombreCompleto: fullName, rol: role, ...userWithoutPassword } = updatedUser;
        res.json({
            ...userWithoutPassword,
            nombreCompleto: fullName,
            fullName,
            rol: role,
            role,
            activo: updatedUser.activo,
            mustChangePassword: updatedUser.mustChangePassword,
            ...(await getUserPermissionDetails(updatedUser.id, role)),
            directPermissions: directPermissions.map(item => item.permiso.clave),
            deniedPermissions: deniedPermissions.map(item => item.permiso.clave)
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar usuario' });
    }
});

// Delete user
router.delete('/:id', requirePermission('usuarios.eliminar'), requireRecentAuthentication, async (req, res) => {
    const { inmobiliariaId, role: actorRole } = (req as AuthRequest).user!;
    const { id } = req.params;

    if (Number(id) === (req as AuthRequest).user!.id) {
        return res.status(400).json({ message: 'No puedes eliminarte a ti mismo' });
    }

    try {
        const user = await prisma.usuario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        if (!isRoleBelow(user.rol, actorRole)) {
            return res.status(403).json({ message: 'No podés desactivar un usuario con rol igual o superior al tuyo' });
        }

        const permissions = await getUserPermissions(user.id, user.rol);
        if (permissions.includes('usuarios.permisos')) {
            if (!(await assertDoesNotRemoveLastPermissionManager(inmobiliariaId, user.id, [], res))) {
                return;
            }
        }

        await prisma.usuario.update({
            where: { id: user.id },
            data: { activo: false, sessionVersion: { increment: 1 } }
        });
        await revokeAllUserSessions(user.id);

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'DESACTIVAR_USUARIO',
            entidad: 'Usuario',
            entidadId: user.id,
            detalle: `Usuario eliminado: ${user.email}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });

        res.json({ message: 'Usuario desactivado. Su historial se conserva y sus sesiones fueron revocadas.' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar usuario' });
    }
});

export default router;
