import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { PERMISSION_CAPABILITIES } from '../src/config/permissions.catalog';

const prisma = new PrismaClient();

async function syncPermissions() {
    for (const capability of PERMISSION_CAPABILITIES) {
        const accion = capability.key.split('.').at(-1)!;
        await prisma.permiso.upsert({
            where: { clave: capability.key },
            update: { descripcion: capability.label, modulo: capability.group, accion },
            create: { clave: capability.key, descripcion: capability.label, modulo: capability.group, accion }
        });
    }
}

async function main() {
    await syncPermissions();
    if (process.env.RUN_DEMO_SEED !== 'true') {
        console.log('Catálogo de permisos sincronizado. Seed demo omitido.');
        return;
    }
    if (process.env.NODE_ENV === 'production') throw new Error('RUN_DEMO_SEED no puede ejecutarse en producción');
    const demoPassword = process.env.DEMO_ADMIN_PASSWORD;
    if (!demoPassword || demoPassword.length < 12) throw new Error('DEMO_ADMIN_PASSWORD debe tener al menos 12 caracteres');

    const inmobiliaria = await prisma.inmobiliaria.upsert({
        where: { id: 1 }, update: {}, create: { id: 1, nombre: 'Inmobiliaria Demo' }
    });
    await prisma.usuario.upsert({
        where: { email: 'admin@demo.local' },
        update: { tipo: 'ADMIN', rolId: null, activo: true, inmobiliariaId: inmobiliaria.id },
        create: {
            email: 'admin@demo.local', password: await bcrypt.hash(demoPassword, 10),
            nombreCompleto: 'Administrador', tipo: 'ADMIN', inmobiliariaId: inmobiliaria.id
        }
    });
    console.log('Seed demo ejecutado correctamente');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => prisma.$disconnect());
