import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Get all owners for the agency
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    try {
        const owners = await prisma.propietario.findMany({
            where: { inmobiliariaId },
            orderBy: { nombreCompleto: 'asc' }
        });
        res.json(owners);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener propietarios' });
    }
});

// Create owner
router.post('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { nombreCompleto, telefono, email } = req.body;

    try {
        const owner = await prisma.propietario.create({
            data: {
                nombreCompleto,
                telefono,
                email,
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.status(201).json(owner);
    } catch (error) {
        res.status(500).json({ message: 'Error al crear propietario' });
    }
});

// Update owner
router.put('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreCompleto, telefono, email } = req.body;

    try {
        // Verify ownership
        const existing = await prisma.propietario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Propietario no encontrado' });
        }

        const owner = await prisma.propietario.update({
            where: { id: Number(id) },
            data: {
                nombreCompleto,
                telefono,
                email,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.json(owner);
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar propietario' });
    }
});

// Delete owner
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const existing = await prisma.propietario.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Propietario no encontrado' });
        }

        await prisma.propietario.delete({
            where: { id: Number(id) }
        });
        res.json({ message: 'Propietario eliminado' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar propietario' });
    }
});

export default router;
