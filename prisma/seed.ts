import "dotenv/config";
import { PrismaClient, EstadoPersona, TipoPropiedad, EstadoPropiedad } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
    if (process.env.RUN_DEMO_SEED !== "true") {
        console.log("Seed omitido. Defina RUN_DEMO_SEED=true solo en entornos demo/desarrollo.");
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
