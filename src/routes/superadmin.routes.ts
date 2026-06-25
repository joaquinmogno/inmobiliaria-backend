import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/permissions.middleware';
import { auditService } from '../services/audit.service';
import { getClientIp, getUserAgent, validatePasswordStrength } from '../services/security.service';
import bcrypt from 'bcrypt';
import { z } from 'zod';

const router = Router();

router.use(authenticateToken);
router.use(requireSuperAdmin);

const createAgencySchema = z.object({
    nombre: z.string().trim().min(2).max(140),
    direccion: z.string().trim().max(180).optional().nullable(),
    emailAdmin: z.string().trim().toLowerCase().email().max(254),
    passwordAdmin: z.string().min(12).max(128),
    nombreCompletoAdmin: z.string().trim().min(2).max(120)
});

const statusSchema = z.object({
    activa: z.boolean()
});

// Métricas Globales
router.get('/metrics', async (req, res) => {
    try {
        const [totalInmobiliarias, totalUsuarios, totalContratos, totalPropiedades] = await Promise.all([
            prisma.inmobiliaria.count({ where: { nombre: { not: 'SaaS Platform Home' } } }),
            prisma.usuario.count({ where: { rol: { not: 'SUPERADMIN' } } }),
            prisma.contrato.count(),
            prisma.propiedad.count()
        ]);

        res.json({
            totalInmobiliarias,
            totalUsuarios,
            totalContratos,
            totalPropiedades
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener métricas' });
    }
});

// Listar Inmobiliarias (clientes)
router.get('/inmobiliarias', async (req, res) => {
    try {
        const inmobiliarias = await prisma.inmobiliaria.findMany({
            where: { nombre: { not: 'SaaS Platform Home' } },
            include: {
                _count: {
                    select: { usuarios: true, contratos: true, propiedades: true }
                }
            },
            orderBy: { fechaCreacion: 'desc' }
        });
        res.json(inmobiliarias);
    } catch (error) {
        res.status(500).json({ message: 'Error obteniendo inmobiliarias' });
    }
});

// Crear nueva inmobiliaria (y su primer admin)
router.post('/inmobiliarias', async (req, res) => {
    const validation = createAgencySchema.safeParse(req.body);
    if (!validation.success) {
        return res.status(400).json({
            message: 'Datos de entrada inválidos',
            errors: validation.error.issues.map(issue => issue.message)
        });
    }

    const { nombre, direccion, emailAdmin, passwordAdmin, nombreCompletoAdmin } = validation.data;
    const passwordErrors = validatePasswordStrength(passwordAdmin, [emailAdmin, nombreCompletoAdmin]);
    if (passwordErrors.length > 0) {
        return res.status(400).json({ message: 'La contraseña no cumple la política de seguridad', errors: passwordErrors });
    }

    try {
        // Verificar que el email no exista
        const existeEmail = await prisma.usuario.findUnique({ where: { email: emailAdmin } });
        if (existeEmail) {
            return res.status(400).json({ message: 'El correo electrónico ya está registrado' });
        }

        const hashedPassword = await bcrypt.hash(passwordAdmin, 10);

        const nuevaInmo = await prisma.inmobiliaria.create({
            data: {
                nombre,
                direccion,
                activa: true,
                usuarios: {
                    create: {
                        email: emailAdmin,
                        password: hashedPassword,
                        nombreCompleto: nombreCompletoAdmin,
                        rol: 'ADMIN',
                        mustChangePassword: true
                    }
                }
            }
        });

        await auditService.log({
            usuarioId: (req as any).user?.id,
            inmobiliariaId: nuevaInmo.id,
            accion: 'CREAR_INMOBILIARIA',
            entidad: 'Inmobiliaria',
            entidadId: nuevaInmo.id,
            detalle: `Inmobiliaria creada: ${nuevaInmo.nombre}`,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });

        res.status(201).json(nuevaInmo);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear la inmobiliaria y su administrador' });
    }
});

// Suspender/Activar inmobiliaria
router.patch('/inmobiliarias/:id/status', async (req, res) => {
    try {
        const id = Number(req.params.id);
        const validation = statusSchema.safeParse(req.body);

        if (!Number.isInteger(id) || id <= 0 || !validation.success) {
            return res.status(400).json({ message: 'Estado inválido' });
        }
        const { activa } = validation.data;

        const inmo = await prisma.inmobiliaria.update({
            where: { id },
            data: { activa }
        });

        await auditService.log({
            usuarioId: (req as any).user?.id,
            inmobiliariaId: inmo.id,
            accion: activa ? 'ACTIVAR_INMOBILIARIA' : 'SUSPENDER_INMOBILIARIA',
            entidad: 'Inmobiliaria',
            entidadId: inmo.id,
            ipAddress: getClientIp(req),
            userAgent: getUserAgent(req),
            severidad: 'CRITICAL'
        });

        res.json({ message: `Inmobiliaria ${activa ? 'activada' : 'suspendida'} correctamente`, inmo });
    } catch (error) {
        res.status(500).json({ message: 'Error al cambiar estado de inmobiliaria' });
    }
});

export default router;
