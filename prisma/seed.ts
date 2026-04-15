import "dotenv/config";
import { PrismaClient, EstadoPersona, TipoPropiedad, EstadoPropiedad } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
    const passwordHash = await bcrypt.hash("admin123", 10);

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
