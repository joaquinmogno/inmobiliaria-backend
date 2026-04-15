import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);

// Get all persons with their computed roles
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search } = req.query;

    try {
        const personas = await prisma.persona.findMany({
            where: {
                inmobiliariaId,
                ...(search ? {
                    OR: [
                        { nombreCompleto: { contains: String(search), mode: 'insensitive' } },
                        { dni: { contains: String(search), mode: 'insensitive' } }
                    ]
                } : {})
            },
            include: {
                _count: {
                    select: {
                        contratosPropietario: true,
                        contratosInquilino: true,
                        contratosGarante: true
                    }
                }
            },
            orderBy: { nombreCompleto: 'asc' }
        });

        // Map to include roles
        const data = personas.map(p => ({
            ...p,
            roles: [
                p._count.contratosPropietario > 0 ? 'Propietario' : null,
                p._count.contratosInquilino > 0 ? 'Inquilino' : null,
                p._count.contratosGarante > 0 ? 'Garante' : null
            ].filter(Boolean)
        }));

        res.json(data);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener personas' });
    }
});

// Create person
router.post('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { nombreCompleto, dni, email, telefono, direccion, estado } = req.body;

    try {
        // Check for duplicate DNI if provided
        if (dni) {
            const existing = await prisma.persona.findFirst({
                where: { dni, inmobiliariaId }
            });
            if (existing) {
                return res.status(400).json({ message: 'Ya existe una persona con ese DNI' });
            }
        }

        const persona = await prisma.persona.create({
            data: {
                nombreCompleto,
                dni,
                email,
                telefono,
                direccion,
                estado: estado || 'ACTIVO',
                inmobiliariaId,
                creadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.status(201).json(persona);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear persona' });
    }
});

// Update person
router.put('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreCompleto, dni, email, telefono, direccion, estado } = req.body;

    try {
        const existing = await prisma.persona.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Persona no encontrada' });
        }

        const persona = await prisma.persona.update({
            where: { id: Number(id) },
            data: {
                nombreCompleto,
                dni,
                email,
                telefono,
                direccion,
                estado,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });
        res.json(persona);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar persona' });
    }
});

// Delete person (soft delete if enforced, or hard delete)
// Requirement says "Estado (activo / inactivo)", so maybe we just toggle status?
// But usually there is a delete button too.
// If contracts exist, hard delete will fail due to foreign keys.
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const existing = await prisma.persona.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Persona no encontrada' });
        }

        // Check dependencies
        const counts = await prisma.persona.findUnique({
            where: { id: Number(id) },
            include: {
                _count: {
                    select: {
                        contratosPropietario: true,
                        contratosInquilino: true,
                        contratosGarante: true
                    }
                }
            }
        });

        if (counts && (counts._count.contratosPropietario > 0 || counts._count.contratosInquilino > 0 || counts._count.contratosGarante > 0)) {
            return res.status(400).json({ message: 'No se puede eliminar: tiene contratos asociados.' });
        }

        await prisma.persona.delete({
            where: { id: Number(id) }
        });
        res.json({ message: 'Persona eliminada' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al eliminar persona' });
    }
});

export default router;
