import bcrypt from 'bcrypt';
import { z } from 'zod';
import { prisma } from '../prisma';
import { validatePasswordStrength } from '../services/security.service';

const installationSchema = z.object({
  nombreInmobiliaria: z.string().trim().min(2).max(140),
  direccion: z.string().trim().max(180).optional(),
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(12).max(128),
  nombreCompleto: z.string().trim().min(2).max(120)
});

async function main() {
  const parsed = installationSchema.safeParse({
    nombreInmobiliaria: process.env.INSTALLATION_NAME || 'Inmobiliaria Local',
    direccion: process.env.INSTALLATION_ADDRESS?.trim() || undefined,
    email: process.env.INITIAL_ADMIN_EMAIL || process.env.INSTALLATION_ADMIN_EMAIL,
    password: process.env.INITIAL_ADMIN_PASSWORD || process.env.INSTALLATION_ADMIN_PASSWORD,
    nombreCompleto:
      process.env.INITIAL_ADMIN_NAME ||
      process.env.INSTALLATION_ADMIN_NAME ||
      'Administrador'
  });

  if (!parsed.success) {
    throw new Error(
      `Configuración de instalación inválida: ${parsed.error.issues.map(issue => issue.message).join('. ')}`
    );
  }

  const { nombreInmobiliaria, direccion, email, password, nombreCompleto } = parsed.data;

  const result = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(81726354)`;

    const inmobiliarias = await tx.inmobiliaria.findMany({
      orderBy: { id: 'asc' },
      take: 2
    });

    if (inmobiliarias.length > 1) {
      throw new Error('La instalación contiene más de una inmobiliaria y requiere revisión manual.');
    }

    const existingUser = await tx.usuario.findUnique({ where: { email } });

    if (existingUser) {
      if (existingUser.tipo !== 'ADMIN') {
        throw new Error(
          `El email ${email} ya pertenece a un usuario común. No se elevaron sus privilegios automáticamente.`
        );
      }

      return { status: 'exists' as const, email };
    }

    const passwordErrors = validatePasswordStrength(password, [email, nombreCompleto, nombreInmobiliaria]);
    if (passwordErrors.length) throw new Error(passwordErrors.join('. '));
    const passwordHash = await bcrypt.hash(password, 10);

    let inmobiliaria = inmobiliarias[0];

    if (!inmobiliaria) {
      inmobiliaria = await tx.inmobiliaria.create({
        data: {
          nombre: nombreInmobiliaria,
          direccion,
          activa: true
        }
      });
    }

    const admin = await tx.usuario.create({
      data: {
        email,
        password: passwordHash,
        nombreCompleto,
        tipo: 'ADMIN',
        activo: true,
        mustChangePassword: false,
        inmobiliariaId: inmobiliaria.id
      }
    });

    await tx.auditLog.create({
      data: {
        accion: 'ADMIN_INICIAL_CREADO',
        entidad: 'Usuario',
        entidadId: admin.id,
        detalle: `Administrador inicial creado automáticamente para ${email}`,
        usuarioId: admin.id,
        inmobiliariaId: inmobiliaria.id
      }
    });

    return {
      status: inmobiliarias.length === 0 ? 'installation-created' as const : 'admin-created' as const,
      email
    };
  });

  if (result.status === 'exists') {
    console.log(`El administrador inicial ${result.email} ya existe; no se modificaron sus datos ni su contraseña.`);
  } else if (result.status === 'installation-created') {
    console.log(`Instalación y administrador inicial ${result.email} creados correctamente.`);
  } else {
    console.log(`Administrador inicial ${result.email} creado en la instalación existente.`);
  }
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
