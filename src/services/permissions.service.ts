import { prisma } from '../prisma';
export {
    MODULE_PERMISSIONS,
    ROLE_ASSIGNABLE_PERMISSIONS,
    ROLE_PERMISSION_CAPABILITIES,
    SUELDOS_PERMISSIONS,
    getMissingPermissionDependencies
} from '../config/permissions.catalog';
export type { PermissionKey } from '../config/permissions.catalog';
import {
    MODULE_PERMISSIONS,
    ROLE_ASSIGNABLE_PERMISSIONS,
    type PermissionKey
} from '../config/permissions.catalog';

export type UserType = 'ADMIN' | 'USUARIO';
const ROLE_ASSIGNABLE_PERMISSION_SET = new Set<string>(ROLE_ASSIGNABLE_PERMISSIONS);

export async function getUserPermissionDetails(userId: number) {
    const user = await prisma.usuario.findUnique({
        where: { id: userId },
        select: {
            tipo: true,
            rol: {
                select: {
                    id: true,
                    nombre: true,
                    activo: true,
                    permisos: { select: { permiso: { select: { clave: true } } } }
                }
            }
        }
    });

    if (!user) return { permissions: [], rol: null };
    if (user.tipo === 'ADMIN') return { permissions: [...MODULE_PERMISSIONS], rol: null };
    if (!user.rol?.activo) return { permissions: [], rol: user.rol || null };

    return {
        permissions: user.rol.permisos.map(item => item.permiso.clave).filter(key => ROLE_ASSIGNABLE_PERMISSION_SET.has(key)),
        rol: { id: user.rol.id, nombre: user.rol.nombre, activo: user.rol.activo }
    };
}

export async function getUserPermissions(userId: number): Promise<string[]> {
    return (await getUserPermissionDetails(userId)).permissions;
}

export async function userHasPermission(userId: number, tipo: UserType | string, permission: PermissionKey) {
    if (tipo === 'ADMIN') return true;
    return (await getUserPermissions(userId)).includes(permission);
}
