import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { validateBody, requiredText, optionalText } from '../middlewares/validation.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';

const router = Router();

router.use(authenticateToken);

const propiedadSchema = z.object({
    direccion: requiredText('La dirección', 180),
    piso: optionalText(30),
    departamento: optionalText(30),
    tipo: z.enum(['DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO']).optional().default('DEPARTAMENTO'),
    estado: z.enum(['DISPONIBLE', 'ALQUILADO', 'INACTIVO']).optional().default('DISPONIBLE'),
    observaciones: optionalText(1000)
});

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
router.post('/', validateBody(propiedadSchema), async (req, res) => {
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

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: property.id,
            detalle: `Propiedad creada: ${property.direccion}`
        });

        res.status(201).json(property);
    } catch (error) {
        res.status(500).json({ message: 'Error al crear propiedad' });
    }
});

// Update property
router.put('/:id', validateBody(propiedadSchema), async (req, res) => {
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

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: property.id,
            detalle: JSON.stringify({
                direccion: { anterior: existing.direccion, nuevo: property.direccion },
                piso: { anterior: existing.piso, nuevo: property.piso },
                departamento: { anterior: existing.departamento, nuevo: property.departamento },
                tipo: { anterior: existing.tipo, nuevo: property.tipo },
                estado: { anterior: existing.estado, nuevo: property.estado },
                observaciones: { anterior: existing.observaciones, nuevo: property.observaciones }
            })
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

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: Number(id),
            detalle: `Propiedad eliminada: ${existing.direccion}`
        });

        res.json({ message: 'Propiedad eliminada' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar propiedad' });
    }
});

export default router;
