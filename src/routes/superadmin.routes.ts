import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken } from '../middlewares/auth.middleware';
import { requireSuperAdmin } from '../middlewares/permissions.middleware';
import bcrypt from 'bcrypt';

const router = Router();

router.use(authenticateToken);
router.use(requireSuperAdmin);

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
    const { nombre, direccion, emailAdmin, passwordAdmin, nombreCompletoAdmin } = req.body;

    if (!nombre || !emailAdmin || !passwordAdmin || !nombreCompletoAdmin) {
        return res.status(400).json({ message: 'Faltan datos obligatorios' });
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
                        rol: 'ADMIN' // Administrador de esa inmobiliaria
                    }
                }
            }
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
        const { activa } = req.body;

        if (typeof activa !== 'boolean') {
            return res.status(400).json({ message: 'Estado inválido' });
        }

        const inmo = await prisma.inmobiliaria.update({
            where: { id },
            data: { activa }
        });

        res.json({ message: `Inmobiliaria ${activa ? 'activada' : 'suspendida'} correctamente`, inmo });
    } catch (error) {
        res.status(500).json({ message: 'Error al cambiar estado de inmobiliaria' });
    }
});

export default router;
