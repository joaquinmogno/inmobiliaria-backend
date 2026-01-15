import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Get all tenants
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    try {
        const tenants = await prisma.inquilino.findMany({
            where: { inmobiliariaId },
            orderBy: { nombreCompleto: 'asc' }
        });
        res.json(tenants);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener inquilinos' });
    }
});

// Create tenant
router.post('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { nombreCompleto, telefono, email } = req.body;

    try {
        const tenant = await prisma.inquilino.create({
            data: {
                nombreCompleto,
                telefono,
                email,
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.status(201).json(tenant);
    } catch (error) {
        res.status(500).json({ message: 'Error al crear inquilino' });
    }
});

// Update tenant
router.put('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreCompleto, telefono, email } = req.body;

    try {
        const existing = await prisma.inquilino.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Inquilino no encontrado' });
        }

        const tenant = await prisma.inquilino.update({
            where: { id: Number(id) },
            data: {
                nombreCompleto,
                telefono,
                email,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.json(tenant);
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar inquilino' });
    }
});

// Delete tenant
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const existing = await prisma.inquilino.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Inquilino no encontrado' });
        }

        await prisma.inquilino.delete({
            where: { id: Number(id) }
        });
        res.json({ message: 'Inquilino eliminado' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar inquilino' });
    }
});

export default router;
