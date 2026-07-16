import { prisma } from '../prisma';

export const SUELDOS_PERMISSIONS = [
    'sueldos.ver',
    'sueldos.crear',
    'sueldos.editar',
    'sueldos.eliminar'
] as const;

export const MODULE_PERMISSIONS = [
    'contratos.ver',
    'contratos.crear',
    'contratos.editar',
    'contratos.eliminar',
    'caja_chica.ver',
    'caja_chica.crear',
    'caja_chica.editar',
    'caja_chica.eliminar',
    'liquidaciones.ver',
    'liquidaciones.crear',
    'liquidaciones.editar',
    'liquidaciones.eliminar',
    'pagos.ver',
    'pagos.crear',
    'pagos.editar',
    'pagos.eliminar',
    'propiedades.ver',
    'propiedades.crear',
    'propiedades.editar',
    'propiedades.eliminar',
    'personas.ver',
    'personas.crear',
    'personas.editar',
    'personas.eliminar',
    'configuracion.perfil.ver',
    'configuracion.perfil.editar',
    'configuracion.backups.ver',
    'configuracion.backups.crear',
    'configuracion.backups.eliminar',
    'configuracion.backups.descargar',
    'configuracion.auditoria.ver',
    'reportes.dashboard.ver',
    'reportes.contratos.ver',
    'reportes.morosidad.ver',
    'reportes.financieros.ver',
    'usuarios.ver',
    'usuarios.crear',
    'usuarios.editar',
    'usuarios.eliminar',
    'usuarios.permisos',
    'usuarios.asignar_rol',
    'contratos.archivos.ver',
    'contratos.restaurar',
    ...SUELDOS_PERMISSIONS
] as const;

export type PermissionKey = typeof MODULE_PERMISSIONS[number] | string;

export const ADMIN_ROLES = ['SUPERADMIN', 'OWNER', 'JEFE', 'ADMIN'] as const;
const ROLE_RANK: Record<string, number> = { AGENTE: 1, ADMIN: 2, JEFE: 3, OWNER: 4, SUPERADMIN: 5 };

export const isRoleBelow = (targetRole: string, actorRole: string) =>
    (ROLE_RANK[targetRole] || 0) < (ROLE_RANK[actorRole] || 0);

export const canCreateRole = (actorRole: string, newRole: string) =>
    isRoleBelow(newRole, actorRole) || (actorRole === 'OWNER' && newRole === 'OWNER') || actorRole === 'SUPERADMIN';

export const isAdminRole = (role?: string) => !!role && ADMIN_ROLES.includes(role as typeof ADMIN_ROLES[number]);

export function resolveEffectivePermissions(
    rolePermissions: string[],
    directPermissions: string[],
    deniedPermissions: string[]
): string[] {
    const denied = new Set(deniedPermissions);
    return Array.from(new Set([...rolePermissions, ...directPermissions]))
        .filter(permission => !denied.has(permission));
}

export async function getUserPermissionDetails(userId: number, role: string) {
    const [rolePermissions, userPermissions] = await Promise.all([
        prisma.rolPermiso.findMany({
            where: { rol: role as any },
            select: { permiso: { select: { clave: true } } }
        }),
        prisma.usuarioPermiso.findMany({
            where: { usuarioId: userId },
            select: { permiso: { select: { clave: true } } }
        })
    ]);
    const deniedPermissions = await prisma.usuarioPermisoDenegado.findMany({
        where: { usuarioId: userId },
        select: { permiso: { select: { clave: true } } }
    });

    const inherited = rolePermissions.map(item => item.permiso.clave);
    const direct = userPermissions.map(item => item.permiso.clave);
    const denied = deniedPermissions.map(item => item.permiso.clave);

    return {
        inheritedPermissions: inherited,
        directPermissions: direct,
        deniedPermissions: denied,
        permissions: resolveEffectivePermissions(inherited, direct, denied)
    };
}

export async function getUserPermissions(userId: number, role: string): Promise<string[]> {
    const details = await getUserPermissionDetails(userId, role);
    return details.permissions;
}

export async function userHasPermission(userId: number, role: string, permission: PermissionKey): Promise<boolean> {
    const permissions = await getUserPermissions(userId, role);
    return permissions.includes(permission);
}
