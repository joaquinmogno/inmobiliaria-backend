import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { upload } from '../middlewares/upload.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import {
    validateBody,
    dateOnlyString,
    optionalDateOnlyString,
    nonNegativeDecimal,
    positiveDecimal,
    optionalText,
    optionalBooleanFromForm
} from '../middlewares/validation.middleware';
import { z } from 'zod';

const router = Router();

router.use(authenticateToken);

const idListFromForm = z.preprocess(value => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
    return value;
}, z.array(z.coerce.number().int().positive()).min(1, 'Debe seleccionar al menos una persona'));

const contractCreateSchema = z.object({
    fechaInicio: dateOnlyString('La fecha de inicio'),
    fechaFin: dateOnlyString('La fecha de fin'),
    fechaActualizacion: optionalDateOnlyString('La fecha de actualización'),
    observaciones: optionalText(2000),
    propiedadId: z.coerce.number().int().positive('Propiedad inválida'),
    propietarioIds: idListFromForm,
    inquilinoIds: idListFromForm,
    montoAlquiler: positiveDecimal('El monto de alquiler'),
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional().default(0),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional()),
    pagaHonorarios: z.enum(['INQUILINO', 'PROPIETARIO']).optional().default('INQUILINO'),
    diaVencimiento: z.coerce.number().int().min(1).max(31).optional().default(10),
    porcentajeActualizacion: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de actualización').max(999).optional()),
    tipoAjuste: optionalText(80),
    administrado: optionalBooleanFromForm.default(true),
    honorarioInicial: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El honorario inicial').optional()),
    honorarioInicialMetodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional()
});

const contractUpdateSchema = contractCreateSchema
    .omit({ propiedadId: true, propietarioIds: true, inquilinoIds: true, honorarioInicial: true, honorarioInicialMetodoPago: true })
    .partial();

const contractStatusSchema = z.object({
    estado: z.enum(['ACTIVO', 'FINALIZADO', 'RESCINDIDO'])
});

const contractRentUpdateSchema = z.object({
    montoNuevo: positiveDecimal('El monto nuevo'),
    fechaProximaNueva: dateOnlyString('La próxima fecha'),
    observaciones: optionalText(1000)
});

// Get all contracts
router.get('/', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search } = req.query;

    try {
        const contracts = await prisma.contrato.findMany({
            where: { 
                inmobiliariaId,
                ...(search ? {
                    OR: [
                        { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } },
                        { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                        { propietarios: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } }
                    ]
                } : {})
            },
            include: {
                propiedad: true,
                inquilinos: {
                    where: { esPrincipal: true },
                    include: { persona: true }
                },
                propietarios: {
                    where: { esPrincipal: true },
                    include: { persona: true }
                },
                adjuntos: true
            },
            orderBy: { fechaCreacion: 'desc' }
        });
        res.json(contracts);
    } catch (error) {
        console.error('Error fetching contracts:', error);
        res.status(500).json({ message: 'Error al obtener contratos' });
    }
});

// Get upcoming alerts (updates and expirations)
router.get('/alertas', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;

    try {
        const today = new Date();
        const thirtyDaysOut = new Date();
        thirtyDaysOut.setDate(today.getDate() + 30);

        const sixtyDaysOut = new Date();
        sixtyDaysOut.setDate(today.getDate() + 60);

        const contracts = await prisma.contrato.findMany({
            where: {
                inmobiliariaId,
                estado: 'ACTIVO',
                OR: [
                    {
                        fechaProximaActualizacion: {
                            gte: today,
                            lte: thirtyDaysOut
                        }
                    },
                    {
                        fechaFin: {
                            gte: today,
                            lte: sixtyDaysOut
                        }
                    }
                ]
            },
            include: {
                propiedad: true,
                inquilinos: {
                    where: { esPrincipal: true },
                    include: { persona: true }
                },
                propietarios: {
                    where: { esPrincipal: true },
                    include: { persona: true }
                }
            },
            orderBy: { fechaFin: 'asc' }
        });

        res.json(contracts);
    } catch (error) {
        console.error('Error fetching contract alerts:', error);
        res.status(500).json({ message: 'Error al obtener alertas de contratos' });
    }
});


function parseDateOnly(dateStr: string) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return new Date(year, month - 1, day);
}

function compactChanges(changes: Record<string, { anterior: unknown; nuevo: unknown }>) {
    return JSON.stringify(changes, (_key, value) => {
        if (value instanceof Decimal) return value.toString();
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        return value;
    });
}

// Create contract
router.post('/', upload.single('pdf'), validateBody(contractCreateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const {
        fechaInicio,
        fechaFin,
        fechaActualizacion,
        observaciones,
        propiedadId,
        propietarioIds, // Expecting array
        inquilinoIds,   // Expecting array
        montoAlquiler,
        montoHonorarios,
        porcentajeHonorarios,
        pagaHonorarios,
        diaVencimiento,
        porcentajeActualizacion,
        tipoAjuste,
        administrado
    } = req.body;

    const pdfPath = req.file ? `inmobiliaria-${inmobiliariaId}/${req.file.filename}` : null;

    try {
        const pIds = Array.isArray(propietarioIds) ? propietarioIds.map(Number) : [Number(propietarioIds)];
        const iIds = Array.isArray(inquilinoIds) ? inquilinoIds.map(Number) : [Number(inquilinoIds)];

        // Verify entities exist and belong to agency
        const [propiedad, propietarios, inquilinos] = await Promise.all([
            prisma.propiedad.findFirst({ where: { id: Number(propiedadId), inmobiliariaId } }),
            prisma.persona.findMany({ where: { id: { in: pIds }, inmobiliariaId } }),
            prisma.persona.findMany({ where: { id: { in: iIds }, inmobiliariaId } })
        ]);

        if (!propiedad || propietarios.length === 0 || inquilinos.length === 0) {
            return res.status(400).json({ message: 'Entidades relacionadas inválidas o faltantes' });
        }

        const contract = await prisma.$transaction(async (tx) => {
            const newContract = await tx.contrato.create({
                data: {
                    fechaInicio: parseDateOnly(fechaInicio),
                    fechaFin: parseDateOnly(fechaFin),
                    fechaProximaActualizacion: fechaActualizacion
                        ? parseDateOnly(fechaActualizacion)
                        : null,
                    observaciones,
                    rutaPdf: pdfPath,
                    propiedadId: Number(propiedadId),
                    inmobiliariaId,
                    montoAlquiler: new Decimal(montoAlquiler || 0),
                    montoHonorarios: new Decimal(montoHonorarios || 0),
                    porcentajeHonorarios: porcentajeHonorarios ? new Decimal(porcentajeHonorarios) : null,
                    pagaHonorarios: pagaHonorarios || 'INQUILINO',
                    diaVencimiento: diaVencimiento ? Number(diaVencimiento) : 10,
                    porcentajeActualizacion: porcentajeActualizacion ? new Decimal(porcentajeActualizacion) : null,
                    tipoAjuste: tipoAjuste || null,
                    administrado: administrado === 'true' || administrado === true,
                    creadoPorId: (req as AuthRequest).user!.id,
                    propietarios: {
                        create: pIds.map((id, index) => ({
                            personaId: id,
                            esPrincipal: index === 0
                        }))
                    },
                    inquilinos: {
                        create: iIds.map((id, index) => ({
                            personaId: id,
                            esPrincipal: index === 0
                        }))
                    }
                }
            });

            if (req.body.honorarioInicial && Number(req.body.honorarioInicial) > 0) {
                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Honorarios por Alta de Contrato - ${propiedad.direccion}`,
                        monto: new Decimal(req.body.honorarioInicial),
                        fecha: new Date(), // Utilizamos la fecha actual de cobro
                        creadoPorId: (req as AuthRequest).user!.id,
                        contratoId: newContract.id,
                        metodoPago: req.body.honorarioInicialMetodoPago || 'EFECTIVO'
                    }
                });
            }

            return newContract;
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CREAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: contract.id,
            detalle: `Contrato creado para propiedad: ${propiedad.direccion}`
        });

        res.status(201).json(contract);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al crear contrato' });
    }
});

// Get contract details
router.get('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: {
                propiedad: true,
                inquilinos: {
                    include: { persona: true },
                    orderBy: { esPrincipal: 'desc' }
                },
                propietarios: {
                    include: { persona: true },
                    orderBy: { esPrincipal: 'desc' }
                },
                adjuntos: true,
                creadoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                actualizadoPor: {
                    select: { id: true, nombreCompleto: true, email: true }
                },
                actualizaciones: {
                    orderBy: { fechaActualizacion: 'desc' },
                    include: { usuario: true }
                }
            }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const auditLogs = await auditService.history({
            inmobiliariaId,
            entidad: 'Contrato',
            entidadId: Number(id)
        });

        res.json({ ...contract, auditLogs });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener contrato' });
    }
});

// Add attachment
router.post('/:id/adjuntos', upload.single('archivo'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreArchivo } = req.body;

    if (!req.file) {
        return res.status(400).json({ message: 'No se subió ningún archivo' });
    }

    const filePath = `inmobiliaria-${inmobiliariaId}/${req.file.filename}`;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const attachment = await prisma.adjuntoContrato.create({
            data: {
                rutaArchivo: filePath,
                nombreArchivo: nombreArchivo || req.file.originalname,
                contratoId: Number(id)
            }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'AGREGAR_ADJUNTO_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: `Adjunto agregado: ${attachment.nombreArchivo || req.file.originalname}`
        });

        res.status(201).json(attachment);
    } catch (error) {
        res.status(500).json({ message: 'Error al subir adjunto' });
    }
});

// Soft delete (Move to trash)
router.delete('/:id', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.update({
            where: { id: Number(id) },
            data: {
                estado: 'PAPELERA',
                eliminadoEn: new Date(),
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: 'Contrato movido a la papelera'
        });

        res.json({ message: 'Contrato movido a la papelera' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar contrato' });
    }
});

// Restore contract
router.post('/:id/restaurar', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.update({
            where: { id: Number(id) },
            data: {
                estado: 'ACTIVO',
                eliminadoEn: null,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'RESTAURAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id)
        });

        res.json({ message: 'Contrato restaurado con éxito' });
    } catch (error) {
        res.status(500).json({ message: 'Error al restaurar contrato' });
    }
});

// Permanent delete
router.delete('/:id/permanente', async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.delete({
            where: { id: Number(id) }
        });
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_PERMANENTE_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: 'Eliminación definitiva del contrato'
        });

        res.json({ message: 'Contrato eliminado permanentemente' });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar contrato permanentemente' });
    }
});

// Update status
router.patch('/:id/estado', validateBody(contractStatusSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { estado } = req.body;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.contrato.update({
            where: { id: Number(id) },
            data: {
                estado,
                actualizadoPorId: (req as AuthRequest).user!.id
            }
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'CAMBIAR_ESTADO_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: compactChanges({ estado: { anterior: contract.estado, nuevo: estado } })
        });

        res.json({ message: `Estado del contrato actualizado a ${estado}` });
    } catch (error) {
        res.status(500).json({ message: 'Error al actualizar estado del contrato' });
    }
});

// Update contract
router.put('/:id', upload.single('pdf'), validateBody(contractUpdateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const {
        fechaInicio,
        fechaFin,
        fechaActualizacion,
        observaciones,
        montoAlquiler,
        montoHonorarios,
        porcentajeHonorarios,
        pagaHonorarios,
        diaVencimiento,
        porcentajeActualizacion,
        tipoAjuste,
        administrado
    } = req.body;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const updateData: any = {
            actualizadoPorId: (req as AuthRequest).user!.id
        };
        const changes: Record<string, { anterior: unknown; nuevo: unknown }> = {};

        if (fechaInicio) {
            updateData.fechaInicio = parseDateOnly(fechaInicio);
            changes.fechaInicio = { anterior: contract.fechaInicio, nuevo: updateData.fechaInicio };
        }
        if (fechaFin) {
            updateData.fechaFin = parseDateOnly(fechaFin);
            changes.fechaFin = { anterior: contract.fechaFin, nuevo: updateData.fechaFin };
        }
        if (fechaActualizacion) {
            updateData.fechaProximaActualizacion = parseDateOnly(fechaActualizacion);
            changes.fechaProximaActualizacion = { anterior: contract.fechaProximaActualizacion, nuevo: updateData.fechaProximaActualizacion };
        }
        if (observaciones !== undefined) {
            updateData.observaciones = observaciones;
            changes.observaciones = { anterior: contract.observaciones, nuevo: observaciones };
        }
        if (montoAlquiler) {
            updateData.montoAlquiler = new Decimal(montoAlquiler);
            changes.montoAlquiler = { anterior: contract.montoAlquiler, nuevo: updateData.montoAlquiler };
        }
        if (montoHonorarios !== undefined) {
            updateData.montoHonorarios = new Decimal(montoHonorarios || 0);
            changes.montoHonorarios = { anterior: contract.montoHonorarios, nuevo: updateData.montoHonorarios };
        }
        if (porcentajeHonorarios !== undefined) {
            updateData.porcentajeHonorarios = porcentajeHonorarios ? new Decimal(porcentajeHonorarios) : null;
            changes.porcentajeHonorarios = { anterior: contract.porcentajeHonorarios, nuevo: updateData.porcentajeHonorarios };
        }
        if (pagaHonorarios) {
            updateData.pagaHonorarios = pagaHonorarios;
            changes.pagaHonorarios = { anterior: contract.pagaHonorarios, nuevo: pagaHonorarios };
        }
        if (diaVencimiento) {
            updateData.diaVencimiento = Number(diaVencimiento);
            changes.diaVencimiento = { anterior: contract.diaVencimiento, nuevo: updateData.diaVencimiento };
        }
        if (porcentajeActualizacion !== undefined) {
            updateData.porcentajeActualizacion = porcentajeActualizacion ? new Decimal(porcentajeActualizacion) : null;
            changes.porcentajeActualizacion = { anterior: contract.porcentajeActualizacion, nuevo: updateData.porcentajeActualizacion };
        }
        if (tipoAjuste !== undefined) {
            updateData.tipoAjuste = tipoAjuste || null;
            changes.tipoAjuste = { anterior: contract.tipoAjuste, nuevo: updateData.tipoAjuste };
        }
        if (administrado !== undefined) {
            updateData.administrado = administrado === 'true' || administrado === true;
            changes.administrado = { anterior: contract.administrado, nuevo: updateData.administrado };
        }
        if (req.file) {
            updateData.rutaPdf = `inmobiliaria-${inmobiliariaId}/${req.file.filename}`;
            changes.rutaPdf = { anterior: contract.rutaPdf, nuevo: updateData.rutaPdf };
        }

        const updated = await prisma.contrato.update({
            where: { id: Number(id) },
            data: updateData,
            include: { 
                propiedad: true, 
                inquilinos: { include: { persona: true } }, 
                propietarios: { include: { persona: true } }, 
                adjuntos: true 
            }
        });
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: compactChanges(changes)
        });

        res.json(updated);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar contrato' });
    }
});

// Actualizar monto de alquiler con registro de historia
router.post('/:id/actualizar', validateBody(contractRentUpdateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { montoNuevo, fechaProximaNueva, observaciones } = req.body;

    try {
        const contrato = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contrato) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const result = await prisma.$transaction(async (tx) => {
            // 1. Crear registro de historia
            await tx.actualizacionContrato.create({
                data: {
                    contratoId: Number(id),
                    montoAnterior: contrato.montoAlquiler,
                    montoNuevo: new Decimal(montoNuevo),
                    fechaProximaAnterior: contrato.fechaProximaActualizacion,
                    fechaProximaNueva: parseDateOnly(fechaProximaNueva),
                    observaciones,
                    usuarioId: (req as AuthRequest).user!.id
                }
            });

            // 2. Actualizar el contrato
            const actualizado = await tx.contrato.update({
                where: { id: Number(id) },
                data: {
                    montoAlquiler: new Decimal(montoNuevo),
                    fechaProximaActualizacion: parseDateOnly(fechaProximaNueva),
                    actualizadoPorId: (req as AuthRequest).user!.id
                },
                include: {
                    propiedad: true,
                    inquilinos: { include: { persona: true } },
                    propietarios: { include: { persona: true } },
                    adjuntos: true,
                    actualizaciones: {
                        orderBy: { fechaActualizacion: 'desc' },
                        include: { usuario: true }
                    }
                }
            });

            return actualizado;
        });

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ACTUALIZAR_ALQUILER_CON_HISTO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: `Actualización de monto de alquiler: ${contrato.montoAlquiler} -> ${montoNuevo}`
        });

        res.json(result);
    } catch (error) {
        console.error('Error al actualizar monto de contrato:', error);
        res.status(500).json({ message: 'Error al actualizar contrato' });
    }
});

export default router;

