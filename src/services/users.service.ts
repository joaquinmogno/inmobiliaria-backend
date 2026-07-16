import { prisma } from '../prisma';

interface PermissionRecord { id: number; clave: string }
interface CreateUserInput {
    email: string;
    hashedPassword: string;
    nombreCompleto: string;
    rol: 'OWNER' | 'JEFE' | 'ADMIN' | 'AGENTE';
    inmobiliariaId: number;
    permissions: string[];
    deniedPermissions: string[];
    catalog: PermissionRecord[];
}

export function createUserWithPermissions(input: CreateUserInput) {
    return prisma.$transaction(async tx => {
        const created = await tx.usuario.create({ data: { email: input.email, password: input.hashedPassword, nombreCompleto: input.nombreCompleto, rol: input.rol, inmobiliariaId: input.inmobiliariaId, mustChangePassword: true } });
        const allowed = new Set(input.permissions);
        const denied = new Set(input.deniedPermissions);
        if (allowed.size) await tx.usuarioPermiso.createMany({ data: input.catalog.filter(item => allowed.has(item.clave)).map(item => ({ usuarioId: created.id, permisoId: item.id })) });
        if (denied.size) await tx.usuarioPermisoDenegado.createMany({ data: input.catalog.filter(item => denied.has(item.clave)).map(item => ({ usuarioId: created.id, permisoId: item.id })) });
        return created;
    });
}
