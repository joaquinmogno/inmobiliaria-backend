import { prisma } from '../prisma';
import bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';

async function createAgency(nombre: string, adminEmail: string, adminPassword: string, adminNombre: string) {
    try {
        const passwordHash = await bcrypt.hash(adminPassword, 10);

        const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
            const inmobiliaria = await tx.inmobiliaria.create({
                data: {
                    nombre: nombre,
                }
            });

            const admin = await tx.usuario.create({
                data: {
                    email: adminEmail,
                    password: passwordHash,
                    nombreCompleto: adminNombre,
                    rol: 'ADMIN',
                    inmobiliariaId: inmobiliaria.id
                }
            });

            return { inmobiliaria, admin };
        });

        console.log('-----------------------------------');
        console.log('Inmobiliaria creada con éxito:');
        console.log(`ID: ${result.inmobiliaria.id}`);
        console.log(`Nombre: ${result.inmobiliaria.nombre}`);
        console.log('-----------------------------------');
        console.log('Usuario Administrador creado:');
        console.log(`Email: ${result.admin.email}`);
        console.log(`Nombre: ${result.admin.nombreCompleto}`);
        console.log('-----------------------------------');

    } catch (error) {
        console.error('Error al crear la inmobiliaria:', error);
    } finally {
        await prisma.$disconnect();
    }
}

// Obtener argumentos de la línea de comandos
const args = process.argv.slice(2);
if (args.length < 4) {
    console.log('Uso: npx ts-node src/scripts/create-agency.ts "Nombre Inmobiliaria" "email@admin.com" "password123" "Nombre Admin"');
} else {
    const [nombre, email, password, adminNombre] = args;
    createAgency(nombre, email, password, adminNombre);
}
