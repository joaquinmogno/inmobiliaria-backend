import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { validateBody, requiredText, optionalText } from '../middlewares/validation.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);

const personaSchema = z.object({
    nombreCompleto: requiredText('El nombre completo', 140),
    dni: optionalText(30),
    email: z.preprocess(
        value => value === '' ? undefined : value,
        z.string().trim().toLowerCase().email('Email inválido').max(254).optional()
    ),
    telefono: optionalText(40),
    direccion: optionalText(180),
    estado: z.enum(['ACTIVO', 'INACTIVO']).optional().default('ACTIVO')
});

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
router.post('/', validateBody(personaSchema), async (req, res) => {
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

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_PERSONA',
            entidad: 'Persona',
            entidadId: persona.id,
            detalle: `Persona creada: ${persona.nombreCompleto}`
        });

        res.status(201).json(persona);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear persona' });
    }
});

// Update person
router.put('/:id', validateBody(personaSchema), async (req, res) => {
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

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_PERSONA',
            entidad: 'Persona',
            entidadId: persona.id,
            detalle: JSON.stringify({
                nombreCompleto: { anterior: existing.nombreCompleto, nuevo: persona.nombreCompleto },
                dni: { anterior: existing.dni, nuevo: persona.dni },
                email: { anterior: existing.email, nuevo: persona.email },
                telefono: { anterior: existing.telefono, nuevo: persona.telefono },
                direccion: { anterior: existing.direccion, nuevo: persona.direccion },
                estado: { anterior: existing.estado, nuevo: persona.estado }
            })
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

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_PERSONA',
            entidad: 'Persona',
            entidadId: Number(id),
            detalle: `Persona eliminada: ${existing.nombreCompleto}`
        });

        res.json({ message: 'Persona eliminada' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al eliminar persona' });
    }
});

export default router;
