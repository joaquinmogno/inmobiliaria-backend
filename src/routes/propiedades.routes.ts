import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Get all properties
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search } = req.query;

    try {
        const properties = await prisma.propiedad.findMany({
            where: {
                inmobiliariaId,
                ...(search ? {
                    direccion: { contains: String(search), mode: 'insensitive' }
                } : {})
            },
            // propietario removed from include as it is no longer directly linked
            orderBy: { direccion: 'asc' }
        });
        res.json(properties);
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener propiedades' });
    }
});

// Create property
router.post('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { direccion, piso, departamento, tipo, estado, observaciones } = req.body;

    try {
        const property = await prisma.propiedad.create({
            data: {
                direccion,
                piso,
                departamento,
                tipo,
                estado,
                observaciones,
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.status(201).json(property);
    } catch (error) {
        res.status(500).json({ message: 'Error al crear propiedad' });
    }
});

// Update property
router.put('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { direccion, piso, departamento, tipo, estado, observaciones } = req.body;

    try {
        const existing = await prisma.propiedad.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Propiedad no encontrada' });
        }

        const property = await prisma.propiedad.update({
            where: { id: Number(id) },
            data: {
                direccion,
                piso,
                departamento,
                tipo,
                estado,
                observaciones,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.json(property);
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar propiedad' });
    }
});

// Delete property
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const existing = await prisma.propiedad.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Propiedad no encontrada' });
        }

        await prisma.propiedad.delete({
            where: { id: Number(id) }
        });
        res.json({ message: 'Propiedad eliminada' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar propiedad' });
    }
});

export default router;
