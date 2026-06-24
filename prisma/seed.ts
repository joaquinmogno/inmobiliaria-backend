import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

const permissions = [
    ["contratos.ver", "Ver contratos"],
    ["contratos.crear", "Crear contratos"],
    ["contratos.editar", "Editar contratos"],
    ["contratos.eliminar", "Eliminar contratos"],
    ["contratos.archivos.ver", "Ver archivos de contratos"],
    ["contratos.restaurar", "Restaurar contratos"],
    ["caja_chica.ver", "Ver caja chica"],
    ["caja_chica.crear", "Crear caja chica"],
    ["caja_chica.editar", "Editar caja chica"],
    ["caja_chica.eliminar", "Eliminar caja chica"],
    ["liquidaciones.ver", "Ver liquidaciones"],
    ["liquidaciones.crear", "Crear liquidaciones"],
    ["liquidaciones.editar", "Editar liquidaciones"],
    ["liquidaciones.eliminar", "Eliminar liquidaciones"],
    ["pagos.ver", "Ver pagos"],
    ["pagos.crear", "Crear pagos"],
    ["pagos.editar", "Editar pagos"],
    ["pagos.eliminar", "Eliminar pagos"],
    ["propiedades.ver", "Ver propiedades"],
    ["propiedades.crear", "Crear propiedades"],
    ["propiedades.editar", "Editar propiedades"],
    ["propiedades.eliminar", "Eliminar propiedades"],
    ["personas.ver", "Ver personas"],
    ["personas.crear", "Crear personas"],
    ["personas.editar", "Editar personas"],
    ["personas.eliminar", "Eliminar personas"],
    ["usuarios.ver", "Ver usuarios"],
    ["usuarios.crear", "Crear usuarios"],
    ["usuarios.editar", "Editar usuarios"],
    ["usuarios.eliminar", "Eliminar usuarios"],
    ["usuarios.permisos", "Administrar permisos de usuarios"],
    ["configuracion.perfil.ver", "Ver perfil de la inmobiliaria"],
    ["configuracion.perfil.editar", "Editar perfil de la inmobiliaria"],
    ["configuracion.backups.ver", "Ver backups"],
    ["configuracion.backups.crear", "Crear backups"],
    ["configuracion.backups.eliminar", "Eliminar backups"],
    ["configuracion.backups.descargar", "Descargar backups"],
    ["configuracion.auditoria.ver", "Ver auditoría"],
    ["reportes.dashboard.ver", "Ver dashboard de reportes"],
    ["reportes.contratos.ver", "Ver métricas de contratos"],
    ["reportes.morosidad.ver", "Ver métricas de morosidad"],
    ["reportes.financieros.ver", "Ver reportes financieros sensibles"],
    ["sueldos.ver", "Ver sueldos"],
    ["sueldos.crear", "Crear sueldos"],
    ["sueldos.editar", "Editar sueldos"],
    ["sueldos.eliminar", "Eliminar sueldos"],
] as const;

const adminPermissions = [
    "configuracion.perfil.ver",
    "configuracion.backups.ver",
    "configuracion.backups.descargar",
    "reportes.dashboard.ver",
    "reportes.contratos.ver",
    "reportes.morosidad.ver",
    "contratos.archivos.ver",
    "contratos.restaurar",
];

async function syncPermissions() {
    await prisma.permiso.createMany({
        data: permissions.map(([clave, descripcion]) => ({ clave, descripcion })),
        skipDuplicates: true
    });

    const allPermissions = await prisma.permiso.findMany({
        where: { clave: { in: permissions.map(([clave]) => clave) } },
        select: { id: true, clave: true }
    });

    await prisma.rolPermiso.createMany({
        data: ["OWNER", "JEFE"].flatMap(rol =>
            allPermissions.map(permission => ({
                rol: rol as any,
                permisoId: permission.id
            }))
        ),
        skipDuplicates: true
    });

    await prisma.rolPermiso.createMany({
        data: allPermissions
            .filter(permission => adminPermissions.includes(permission.clave))
            .map(permission => ({
                rol: "ADMIN",
                permisoId: permission.id
            })),
        skipDuplicates: true
    });
}

async function main() {
    await syncPermissions();

    if (process.env.RUN_DEMO_SEED !== "true") {
        console.log("Permisos sincronizados. Seed demo omitido. Defina RUN_DEMO_SEED=true solo en entornos demo/desarrollo.");
        return;
    }

    if (process.env.NODE_ENV === "production") {
        throw new Error("RUN_DEMO_SEED no puede ejecutarse en produccion");
    }

    const demoPassword = process.env.DEMO_ADMIN_PASSWORD;
    if (!demoPassword || demoPassword.length < 12) {
        throw new Error("DEMO_ADMIN_PASSWORD debe tener al menos 12 caracteres para ejecutar el seed demo");
    }

    const passwordHash = await bcrypt.hash(demoPassword, 10);

    // 1. Inmobiliaria
    const inmobiliaria = await prisma.inmobiliaria.upsert({
        where: { id: 1 },
        update: { nombre: "Ricardo Lavalle Propiedades" },
        create: {
            id: 1,
            nombre: "Ricardo Lavalle Propiedades",
        },
    });

    // 2. Admin
    const admin = await prisma.usuario.upsert({
        where: { email: "admin@lavalle.com" },
        update: {
            password: passwordHash,
            nombreCompleto: "Administrador",
            rol: "ADMIN",
            inmobiliariaId: inmobiliaria.id
        },
        create: {
            email: "admin@lavalle.com",
            password: passwordHash,
            nombreCompleto: "Administrador",
            rol: "ADMIN",
            inmobiliariaId: inmobiliaria.id
        },
    });

    // 3. Personas y Propiedades removidas
    // La base de datos iniciará limpia sin datos falsos.

    console.log("Seed ejecutado correctamente 🚀");
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
