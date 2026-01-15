import "dotenv/config";
import { PrismaClient } from "../src/generated/prisma";
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";

const connectionString = process.env.DATABASE_URL;
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    const passwordHash = await bcrypt.hash("admin123", 10);

    const inmobiliaria = await prisma.inmobiliaria.upsert({
        where: { id: 1 },
        update: { nombre: "Ricardo Lavalle Propiedades" },
        create: {
            id: 1,
            nombre: "Ricardo Lavalle Propiedades",
        },
    });

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

    console.log("Inmobiliaria:", inmobiliaria.nombre);
    console.log("Admin user updated/created:", admin.email);
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
