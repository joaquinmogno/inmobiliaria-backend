import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { validateBody, requiredText, optionalText } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { requireAdmin } from '../middlewares/permissions.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import { syncContractLifecycle } from '../services/contract-lifecycle.service';
import {
    cleanupFailedUpload,
    commitUploadedFile,
    removeUploadedFile,
    upload,
    validateUploadedFileContent
} from '../middlewares/upload.middleware';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate, optimisticVersionSchema } from '../utils/optimistic-lock';
import { withPagination } from '../middlewares/pagination.middleware';

const router = Router();

router.use(authenticateToken);

const registroInmobiliario = optionalText(100).transform(value => value?.normalize('NFKC').toUpperCase());

const propiedadSchema = z.object({
    direccion: requiredText('La dirección', 180),
    piso: optionalText(30),
    departamento: optionalText(30),
    tipo: z.enum(['DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO']).optional().default('DEPARTAMENTO'),
    estado: z.enum(['DISPONIBLE', 'ALQUILADO', 'INACTIVO']).optional().default('DISPONIBLE'),
    observaciones: optionalText(2000),
    servicios: optionalText(2000),
    llaves: optionalText(1000), partidaInmobiliaria: registroInmobiliario, matricula: registroInmobiliario, superficieM2: z.coerce.number().positive().max(100000).optional().nullable()
});
const propiedadUpdateSchema = propiedadSchema.extend({ version: optimisticVersionSchema });

const notaPropiedadSchema = z.object({
    contenido: requiredText('La nota', 2000)
});

// Get all properties
router.get('/', requirePermission('propiedades.ver'), withPagination(25), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search, tipo, estado } = req.query;
    const pagination = res.locals.pagination;

    const propertyTypes = ['DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO'] as const;
    const propertyStates = ['DISPONIBLE', 'ALQUILADO', 'INACTIVO'] as const;
    if (tipo && !propertyTypes.includes(String(tipo) as typeof propertyTypes[number])) {
        return res.status(400).json({ message: 'Tipo de propiedad inválido', code: 'INVALID_PROPERTY_TYPE_FILTER' });
    }
    if (estado && !propertyStates.includes(String(estado) as typeof propertyStates[number])) {
        return res.status(400).json({ message: 'Estado de propiedad inválido', code: 'INVALID_PROPERTY_STATUS_FILTER' });
    }

    try {
        await syncContractLifecycle(inmobiliariaId);
        const term = String(search || '').trim();
        const normalized = term.toUpperCase();
        const where = {
            inmobiliariaId,
            ...(tipo ? { tipo: String(tipo) as typeof propertyTypes[number] } : {}),
            ...(estado ? { estado: String(estado) as typeof propertyStates[number] } : {}),
            ...(term ? { OR: [
                { direccion: { contains: term, mode: 'insensitive' as const } },
                { piso: { contains: term, mode: 'insensitive' as const } },
                { departamento: { contains: term, mode: 'insensitive' as const } },
                { observaciones: { contains: term, mode: 'insensitive' as const } },
                { servicios: { contains: term, mode: 'insensitive' as const } },
                { llaves: { contains: term, mode: 'insensitive' as const } },
                { partidaInmobiliaria: { contains: normalized, mode: 'insensitive' as const } },
                { matricula: { contains: normalized, mode: 'insensitive' as const } },
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

// Operational property dossier: current relationships, contract history and documentation.
router.get('/:id', requirePermission('propiedades.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const propertyId = Number(req.params.id);

    if (!Number.isInteger(propertyId) || propertyId <= 0) {
        return res.status(400).json({ message: 'Propiedad inválida' });
    }

    try {
        await syncContractLifecycle(inmobiliariaId);
        const property = await prisma.propiedad.findFirst({
            where: { id: propertyId, inmobiliariaId },
            include: {
                adjuntos: {
                    where: { eliminadoEn: null },
                    include: { creadoPor: { select: { id: true, nombreCompleto: true } } },
                    orderBy: [{ tipo: 'asc' }, { fechaCreacion: 'desc' }]
                },
                notas: {
                    include: { creadoPor: { select: { id: true, nombreCompleto: true } } },
                    orderBy: { fechaCreacion: 'desc' }
                },
                contratos: {
                    where: { estado: { not: 'PAPELERA' } },
                    orderBy: [{ fechaInicio: 'desc' }, { id: 'desc' }],
                    select: {
                        id: true,
                        fechaInicio: true,
                        fechaFin: true,
                        estado: true,
                        propietarios: {
                            orderBy: { esPrincipal: 'desc' },
                            select: {
                                esPrincipal: true,
                                persona: { select: { id: true, nombreCompleto: true, telefono: true } }
                            }
                        },
                        inquilinos: {
                            orderBy: { esPrincipal: 'desc' },
                            select: {
                                esPrincipal: true,
                                persona: { select: { id: true, nombreCompleto: true, telefono: true } }
                            }
                        }
                    }
                }
            }
        });

        if (!property) return res.status(404).json({ message: 'Propiedad no encontrada' });

        const contratoVigente = property.contratos.find(contract => contract.estado === 'ACTIVO') || null;
        const contratoProgramado = property.contratos.find(contract => contract.estado === 'PROGRAMADO') || null;
        const fuenteTitulares = contratoVigente || contratoProgramado || property.contratos[0] || null;

        res.json({
            ...property,
            contratoVigente,
            contratoProgramado,
            titularesRegistrados: fuenteTitulares?.propietarios || [],
            titularesFuenteContratoId: fuenteTitulares?.id || null,
            ocupantesActuales: contratoVigente?.inquilinos || []
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener el detalle de la propiedad' });
    }
});

// Create property
router.post('/', requirePermission('propiedades.crear'), validateBody(propiedadSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { direccion, piso, departamento, tipo, estado, observaciones, servicios, llaves, partidaInmobiliaria, matricula, superficieM2 } = req.body;

    try {
        const property = await prisma.propiedad.create({
            data: {
                direccion,
                piso,
                departamento,
                tipo,
                estado,
                observaciones,
                servicios,
                llaves,
                partidaInmobiliaria, matricula, superficieM2,
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
router.put('/:id', requirePermission('propiedades.editar'), validateBody(propiedadUpdateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { direccion, piso, departamento, tipo, estado, observaciones, servicios, llaves, version, partidaInmobiliaria, matricula, superficieM2 } = req.body;

    try {
        const existing = await prisma.propiedad.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Propiedad no encontrada' });
        }

        if (existing.version !== version) {
            assertOptimisticUpdate(0, version, existing.version);
        }

        const property = await prisma.$transaction(async tx => {
            const result = await tx.propiedad.updateMany({
                where: { id: Number(id), inmobiliariaId, version },
                data: {
                    direccion,
                    piso,
                    departamento,
                    tipo,
                    estado,
                    observaciones,
                    servicios,
                    llaves,
                    partidaInmobiliaria, matricula, superficieM2,
                    actualizadoPorId: (req as AuthRequest).user!.id,
                    version: { increment: 1 }
                }
            });
            const currentVersion = result.count === 0
                ? (await tx.propiedad.findFirst({ where: { id: Number(id), inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(result.count, version, currentVersion);
            return tx.propiedad.findUniqueOrThrow({ where: { id: Number(id) } });
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
                observaciones: { anterior: existing.observaciones, nuevo: property.observaciones },
                servicios: { anterior: existing.servicios, nuevo: property.servicios },
                llaves: { anterior: existing.llaves, nuevo: property.llaves }
            })
        });

        res.json(property);
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        res.status(500).json({ message: 'Error al actualizar propiedad' });
    }
});

// Historical notes are append-only so operational context is not overwritten.
router.post('/:id/notas', requirePermission('propiedades.editar'), validateBody(notaPropiedadSchema), async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const propertyId = Number(req.params.id);
    const property = await prisma.propiedad.findFirst({
        where: { id: propertyId, inmobiliariaId: actor.inmobiliariaId },
        select: { id: true, direccion: true }
    });

    if (!property) return res.status(404).json({ message: 'Propiedad no encontrada' });

    try {
        const note = await prisma.notaPropiedad.create({
            data: { contenido: req.body.contenido, propiedadId: propertyId, creadoPorId: actor.id },
            include: { creadoPor: { select: { id: true, nombreCompleto: true } } }
        });
        await auditService.log({
            usuarioId: actor.id,
            inmobiliariaId: actor.inmobiliariaId,
            accion: 'AGREGAR_NOTA_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: propertyId,
            detalle: `Nota agregada al dossier de ${property.direccion}`
        });
        res.status(201).json(note);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al guardar la nota' });
    }
});

router.post(
    '/:id/adjuntos',
    requirePermission('propiedades.editar'),
    upload.single('archivo'),
    validateUploadedFileContent,
    cleanupFailedUpload,
    async (req, res) => {
        const actor = (req as AuthRequest).user!;
        const propertyId = Number(req.params.id);
        if (!req.file) return res.status(400).json({ message: 'No se subió ningún archivo' });

        const parsedType = z.enum(['FOTO', 'DOCUMENTO']).safeParse(req.body.tipo);
        if (!parsedType.success) {
            return res.status(400).json({ message: 'Debe indicar si el archivo es una foto o un documento' });
        }

        const property = await prisma.propiedad.findFirst({
            where: { id: propertyId, inmobiliariaId: actor.inmobiliariaId },
            select: { id: true, direccion: true }
        });
        if (!property) return res.status(404).json({ message: 'Propiedad no encontrada' });

        const filePath = await commitUploadedFile(req.file, actor.inmobiliariaId);
        try {
            const suppliedName = typeof req.body.nombreArchivo === 'string' ? req.body.nombreArchivo.trim() : '';
            const attachment = await prisma.adjuntoPropiedad.create({
                data: {
                    rutaArchivo: filePath!,
                    nombreArchivo: (suppliedName || req.file.originalname).slice(0, 255),
                    tipo: parsedType.data,
                    propiedadId: propertyId,
                    creadoPorId: actor.id
                },
                include: { creadoPor: { select: { id: true, nombreCompleto: true } } }
            });
            await auditService.log({
                usuarioId: actor.id,
                inmobiliariaId: actor.inmobiliariaId,
                accion: 'AGREGAR_ADJUNTO_PROPIEDAD',
                entidad: 'Propiedad',
                entidadId: propertyId,
                detalle: `${parsedType.data === 'FOTO' ? 'Foto' : 'Documento'} agregado: ${attachment.nombreArchivo}`
            });
            res.status(201).json(attachment);
        } catch (error) {
            await removeUploadedFile(filePath);
            console.error(error);
            res.status(500).json({ message: 'Error al guardar el archivo de la propiedad' });
        }
    }
);

// La eliminación normal sólo retira el adjunto de la vista operativa: mantiene
// el archivo y el registro para que pueda restaurarse desde la papelera.
router.delete('/:id/adjuntos/:attachmentId', requirePermission('propiedades.editar'), requireRecentAuthentication, async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const propertyId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    const attachment = await prisma.adjuntoPropiedad.findFirst({
        where: {
            id: attachmentId,
            propiedadId: propertyId,
            propiedad: { inmobiliariaId: actor.inmobiliariaId }
        }
    });
    if (!attachment) return res.status(404).json({ message: 'Archivo no encontrado' });

    try {
        await prisma.adjuntoPropiedad.update({
            where: { id: attachment.id },
            data: { eliminadoEn: new Date(), eliminadoPorId: actor.id }
        });
        await auditService.log({
            usuarioId: actor.id,
            inmobiliariaId: actor.inmobiliariaId,
            accion: 'ENVIAR_ADJUNTO_PROPIEDAD_A_PAPELERA',
            entidad: 'Propiedad',
            entidadId: propertyId,
            detalle: `Archivo enviado a papelera: ${attachment.nombreArchivo}`
        });
        res.json({ message: 'Archivo enviado a la papelera y recuperable durante el período de retención' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al eliminar el archivo' });
    }
});

router.get('/:id/adjuntos/papelera', requirePermission('propiedades.editar'), async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const propertyId = Number(req.params.id);
    const attachments = await prisma.adjuntoPropiedad.findMany({
        where: { propiedadId: propertyId, eliminadoEn: { not: null }, propiedad: { inmobiliariaId: actor.inmobiliariaId } },
        include: {
            creadoPor: { select: { id: true, nombreCompleto: true } },
            eliminadoPor: { select: { id: true, nombreCompleto: true } }
        },
        orderBy: [{ eliminadoEn: 'desc' }, { id: 'desc' }]
    });
    res.json({ data: attachments });
});

router.post('/:id/adjuntos/:attachmentId/restaurar', requirePermission('propiedades.editar'), requireRecentAuthentication, async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const propertyId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    const attachment = await prisma.adjuntoPropiedad.findFirst({
        where: { id: attachmentId, propiedadId: propertyId, eliminadoEn: { not: null }, propiedad: { inmobiliariaId: actor.inmobiliariaId } }
    });
    if (!attachment) return res.status(404).json({ message: 'Archivo en papelera no encontrado' });

    try {
        const restored = await prisma.adjuntoPropiedad.update({
            where: { id: attachment.id },
            data: { eliminadoEn: null, eliminadoPorId: null, motivoEliminacion: null },
            include: { creadoPor: { select: { id: true, nombreCompleto: true } } }
        });
        await auditService.log({
            usuarioId: actor.id,
            inmobiliariaId: actor.inmobiliariaId,
            accion: 'RESTAURAR_ADJUNTO_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: propertyId,
            detalle: `Archivo restaurado desde papelera: ${attachment.nombreArchivo}`
        });
        res.json(restored);
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'No se pudo restaurar el archivo' });
    }
});

// La purga física es excepcional y queda restringida a una cuenta administradora.
router.delete('/:id/adjuntos/:attachmentId/permanente', requireAdmin, requireRecentAuthentication, async (req, res) => {
    const actor = (req as AuthRequest).user!;
    const propertyId = Number(req.params.id);
    const attachmentId = Number(req.params.attachmentId);
    const attachment = await prisma.adjuntoPropiedad.findFirst({
        where: { id: attachmentId, propiedadId: propertyId, eliminadoEn: { not: null }, propiedad: { inmobiliariaId: actor.inmobiliariaId } }
    });
    if (!attachment) return res.status(404).json({ message: 'Archivo en papelera no encontrado' });

    try {
        await prisma.adjuntoPropiedad.delete({ where: { id: attachment.id } });
        await removeUploadedFile(attachment.rutaArchivo);
        await auditService.log({
            usuarioId: actor.id,
            inmobiliariaId: actor.inmobiliariaId,
            accion: 'PURGAR_ADJUNTO_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: propertyId,
            severidad: 'WARNING',
            detalle: `Archivo eliminado definitivamente: ${attachment.nombreArchivo}`
        });
        res.json({ message: 'Archivo eliminado definitivamente' });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'No se pudo eliminar definitivamente el archivo' });
    }
});

// Delete property
router.delete('/:id', requirePermission('propiedades.eliminar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const existing = await prisma.propiedad.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: { adjuntos: { select: { rutaArchivo: true } } }
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
        const activeContracts = contractCounts
            .filter(item => item.estado === 'ACTIVO' || item.estado === 'PROGRAMADO')
            .reduce((total, item) => total + item._count, 0);

        if (activeContracts > 0) {
            return res.status(409).json({ message: 'No se puede eliminar ni desactivar una propiedad con contratos vigentes o programados. Finalizá o rescindí esos contratos primero.' });
        }

        // Un inmueble con dossier documental no se borra físicamente: incluso
        // sin contratos, se conserva inactivo para proteger sus antecedentes.
        if (totalContracts > 0 || existing.adjuntos.length > 0) {
            await prisma.propiedad.update({
                where: { id: existing.id },
                data: { estado: 'INACTIVO', actualizadoPorId: (req as AuthRequest).user!.id, version: { increment: 1 } }
            });
        } else {
            await prisma.propiedad.delete({ where: { id: existing.id } });
            await Promise.all(existing.adjuntos.map(file => removeUploadedFile(file.rutaArchivo)));
        }

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: totalContracts > 0 || existing.adjuntos.length > 0 ? 'DESACTIVAR_PROPIEDAD' : 'ELIMINAR_PROPIEDAD',
            entidad: 'Propiedad',
            entidadId: Number(id),
            detalle: `Propiedad eliminada: ${existing.direccion}`
        });

        const deactivated = totalContracts > 0 || existing.adjuntos.length > 0;
        res.json({ message: deactivated ? 'La propiedad conserva su historial documental y quedó inactiva' : 'Propiedad eliminada', deactivated });
    } catch (error) {
        res.status(500).json({ message: 'Error al eliminar propiedad' });
    }
});

export default router;
