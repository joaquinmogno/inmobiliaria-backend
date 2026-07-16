import bcrypt from 'bcrypt';
import { prisma } from '../prisma';
import { validatePasswordStrength } from '../services/security.service';

async function main() {
  const email = process.env.SETUP_SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SETUP_SUPERADMIN_PASSWORD || '';
  const nombreCompleto = process.env.SETUP_SUPERADMIN_NAME?.trim();
  if (!email || !nombreCompleto || !password) throw new Error('Definí SETUP_SUPERADMIN_EMAIL, SETUP_SUPERADMIN_PASSWORD y SETUP_SUPERADMIN_NAME');
  const errors = validatePasswordStrength(password, [email, nombreCompleto]);
  if (errors.length) throw new Error(errors.join('. '));
  const passwordHash = await bcrypt.hash(password, 10);

  await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(81726354)`;
    if (await tx.usuario.findFirst({ where: { rol: 'SUPERADMIN' } })) throw new Error('Ya existe un SUPERADMIN');
    let agency = await tx.inmobiliaria.findFirst({ where: { nombre: 'SaaS Platform Home' } });
    if (!agency) agency = await tx.inmobiliaria.create({ data: { nombre: 'SaaS Platform Home', activa: true } });
    await tx.usuario.create({ data: { email, password: passwordHash, nombreCompleto, rol: 'SUPERADMIN', inmobiliariaId: agency.id, mustChangePassword: false } });
  });
  console.log('SUPERADMIN creado. Eliminá las variables SETUP_SUPERADMIN_* del entorno.');
}

main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
