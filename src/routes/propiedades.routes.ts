import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { validateBody, requiredText, optionalText } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { parsePagination } from '../utils/pagination';

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
router.get('/', requirePermission('propiedades.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search, page, limit } = req.query;
    const pagination = parsePagination(page, limit);

    try {
        const term = String(search || '').trim();
        const normalized = term.toUpperCase();
        const propertyTypes = ['DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO'] as const;
        const propertyStates = ['DISPONIBLE', 'ALQUILADO', 'INACTIVO'] as const;
        const where = {
            inmobiliariaId,
            ...(term ? { OR: [
                { direccion: { contains: term, mode: 'insensitive' as const } },
                ...(propertyTypes.includes(normalized as typeof propertyTypes[number]) ? [{ tipo: normalized as typeof propertyTypes[number] }] : []),
                ...(propertyStates.includes(normalized as typeof propertyStates[number]) ? [{ estado: normalized as typeof propertyStates[number] }] : [])
            ] } : {})
        };
        const [total, properties] = await prisma.$transaction([
          prisma.propiedad.count({ where }),
          prisma.propiedad.findMany({
            where,
            // propietario removed from include as it is no longer directly linked
            orderBy: [{ direccion: 'asc' }, { id: 'asc' }],
            skip: pagination.skip,
            take: pagination.limit
          })
        ]);
        res.json({
            data: properties,
            meta: { total, page: pagination.page, limit: pagination.limit, totalPages: Math.ceil(total / pagination.limit) }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener propiedades' });
    }
});

// Create property
router.post('/', requirePermission('propiedades.crear'), validateBody(propiedadSchema), async (req, res) => {
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
router.put('/:id', requirePermission('propiedades.editar'), validateBody(propiedadSchema), async (req, res) => {
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
router.delete('/:id', requirePermission('propiedades.eliminar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const existing = await prisma.propiedad.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Propiedad no encontrada' });
        }

        const contractCounts = await prisma.contrato.groupBy({
            by: ['estado'],
            where: { propiedadId: existing.id, inmobiliariaId },
            _count: true
        });
        const totalContracts = contractCounts.reduce((total, item) => total + item._count, 0);
        const activeContracts = contractCounts.filter(item => item.estado === 'ACTIVO').reduce((total, item) => total + item._count, 0);

        if (activeContracts > 0) {
            return res.status(409).json({ message: 'No se puede eliminar ni desactivar una propiedad con contratos activos. Finalizá o rescindí esos contratos primero.' });
        }

        if (totalContracts > 0) {
            await prisma.propiedad.update({ where: { id: existing.id }, data: { estado: 'INACTIVO', actualizadoPorId: (req as AuthRequest).user!.id } });
        } else {
            await prisma.propiedad.delete({ where: { id: existing.id } });
        }

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: totalContracts > 0 ? 'DESACTIVAR_PROPIEDAD' : 'ELIMINAR_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: Number(id),
            detalle: `Propiedad eliminada: ${existing.direccion}`
        });

        res.json({ message: totalContracts > 0 ? 'La propiedad conserva su historial y quedó inactiva' : 'Propiedad eliminada', deactivated: totalContracts > 0 });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar propiedad' });
    }
});

export default router;
