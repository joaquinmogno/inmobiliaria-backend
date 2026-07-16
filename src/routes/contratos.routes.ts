import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { cleanupFailedUpload, commitUploadedFile, removeUploadedFile, upload, validateUploadedFileContent } from '../middlewares/upload.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import {
    validateBody,
    dateOnlyString,
    optionalDateOnlyString,
    nonNegativeDecimal,
    positiveDecimal,
    optionalText,
    optionalBooleanFromForm,
    optionalEmail,
    optionalPhone,
    requiredText
} from '../middlewares/validation.middleware';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { logger } from '../services/logger.service';
import { AppError } from '../errors/app-error';
import { requirePermission } from '../middlewares/permissions.middleware';
import { userHasPermission } from '../services/permissions.service';
import { formatCurrency } from '../utils/currency';
import { parsePagination } from '../utils/pagination';
import { resolveMoneda } from '../services/currency-rules.service';
import { deleteContractPermanently } from '../services/contract-deletion.service';
import { TRASH_RETENTION_DAYS } from '../services/maintenance.service';

const router = Router();

router.use(authenticateToken);

const parseJsonField = <T extends z.ZodTypeAny>(schema: T) => z.preprocess(value => {
    if (typeof value !== 'string') return value;

    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}, schema);

const idListFromForm = z.preprocess(value => {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') return value.split(',').map(v => v.trim()).filter(Boolean);
    return value;
}, z.array(z.coerce.number().int().positive()).min(1, 'Debe seleccionar al menos una persona'));

const personCandidateSchema = z.object({
    id: z.coerce.number().int().positive().optional(),
    nombreCompleto: optionalText(140),
    dni: optionalText(30),
    email: optionalEmail(),
    telefono: optionalPhone(),
    direccion: optionalText(180),
    estado: z.enum(['ACTIVO', 'INACTIVO']).optional().default('ACTIVO')
}).superRefine((value, ctx) => {
    if (!value.id && !value.nombreCompleto) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nombreCompleto'],
            message: 'El nombre completo es obligatorio para una persona nueva'
        });
    }
});

const propertyCandidateSchema = z.object({
    direccion: requiredText('La dirección', 180),
    piso: optionalText(30),
    departamento: optionalText(30),
    tipo: z.enum(['DEPARTAMENTO', 'CASA', 'LOCAL', 'OTRO']).optional().default('DEPARTAMENTO'),
    estado: z.enum(['DISPONIBLE', 'ALQUILADO', 'INACTIVO']).optional().default('DISPONIBLE'),
    observaciones: optionalText(1000)
});

const contractCreateSchemaBase = z.object({
    fechaInicio: dateOnlyString('La fecha de inicio'),
    fechaFin: dateOnlyString('La fecha de fin'),
    fechaActualizacion: optionalDateOnlyString('La fecha de actualización'),
    observaciones: optionalText(2000),
    propiedadId: z.coerce.number().int().positive('Propiedad inválida').optional(),
    propiedad: parseJsonField(propertyCandidateSchema).optional(),
    propietarioIds: idListFromForm.optional(),
    inquilinoIds: idListFromForm.optional(),
    propietarios: parseJsonField(z.array(personCandidateSchema).min(1, 'Debe seleccionar al menos un propietario')).optional(),
    inquilinos: parseJsonField(z.array(personCandidateSchema).min(1, 'Debe seleccionar al menos un inquilino')).optional(),
    montoAlquiler: positiveDecimal('El monto de alquiler'),
    montoHonorarios: nonNegativeDecimal('El monto de honorarios').optional().default(0),
    moneda: z.enum(['ARS', 'USD']).optional().default('ARS'),
    porcentajeHonorarios: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de honorarios').max(100).optional()),
    pagaHonorarios: z.enum(['INQUILINO', 'PROPIETARIO']).optional().default('INQUILINO'),
    diaVencimiento: z.coerce.number().int().min(1).max(31).optional().default(10),
    porcentajeActualizacion: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El porcentaje de actualización').max(999).optional()),
    tipoAjuste: optionalText(80),
    administrado: optionalBooleanFromForm.default(true),
    requiereActualizacion: optionalBooleanFromForm.default(true),
    honorarioInicial: z.preprocess(value => value === '' ? undefined : value, nonNegativeDecimal('El honorario inicial').optional()),
    honorarioInicialMetodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS']).optional()
});

const contractCreateSchema = contractCreateSchemaBase.superRefine((value, ctx) => {
    if (!value.propiedadId && !value.propiedad) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['propiedad'],
            message: 'Debe seleccionar una propiedad existente o cargar una nueva'
        });
    }

    if (!value.propietarioIds && !value.propietarios) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['propietarios'],
            message: 'Debe indicar al menos un propietario'
        });
    }

    if (!value.inquilinoIds && !value.inquilinos) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['inquilinos'],
            message: 'Debe indicar al menos un inquilino'
        });
    }

    if (parseDateOnly(value.fechaInicio) > parseDateOnly(value.fechaFin)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fechaFin'],
            message: 'La fecha de fin debe ser posterior o igual a la fecha de inicio'
        });
    }

    if (value.fechaActualizacion && parseDateOnly(value.fechaActualizacion) < parseDateOnly(value.fechaInicio)) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fechaActualizacion'],
            message: 'La próxima actualización no puede ser anterior al inicio del contrato'
        });
    }

    if (value.requiereActualizacion && !value.fechaActualizacion) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['fechaActualizacion'],
            message: 'La próxima actualización es obligatoria si el contrato tiene actualización programada'
        });
    }
});

const contractUpdateSchema = contractCreateSchemaBase
    .omit({ propiedadId: true, propietarioIds: true, inquilinoIds: true, honorarioInicial: true, honorarioInicialMetodoPago: true })
    .partial()
    .extend({
        administrado: optionalBooleanFromForm,
        requiereActualizacion: optionalBooleanFromForm
    });

const contractStatusSchema = z.object({
    estado: z.enum(['ACTIVO', 'FINALIZADO', 'RESCINDIDO'])
});

const contractRentUpdateSchema = z.object({
    montoNuevo: positiveDecimal('El monto nuevo'),
    fechaProximaNueva: dateOnlyString('La próxima fecha'),
    observaciones: optionalText(1000)
});

const normalizeUpdateSettings = (payload: Pick<ContractCreateInput, 'requiereActualizacion' | 'fechaActualizacion' | 'porcentajeActualizacion' | 'tipoAjuste'>) => {
    if (!payload.requiereActualizacion) {
        return {
            requiereActualizacion: false,
            fechaProximaActualizacion: null,
            porcentajeActualizacion: null,
            tipoAjuste: null
        };
    }

    return {
        requiereActualizacion: true,
        fechaProximaActualizacion: payload.fechaActualizacion ? parseDateOnly(payload.fechaActualizacion) : null,
        porcentajeActualizacion: payload.porcentajeActualizacion ? new Decimal(payload.porcentajeActualizacion) : null,
        tipoAjuste: payload.tipoAjuste || null
    };
};

// Get all contracts
router.get('/', requirePermission('contratos.ver'), async (req, res) => {
    const { id: userId, role, inmobiliariaId } = (req as AuthRequest).user!;
    const { search, page, limit, expired, status } = req.query;
    const pagination = parsePagination(page, limit, 10);

    try {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const where: Prisma.ContratoWhereInput = {
                inmobiliariaId,
                ...(status ? { estado: String(status) as any } : {}),
                ...(expired === 'true' ? { fechaFin: { lt: today } } : {}),
                ...(expired === 'false' ? { fechaFin: { gte: today } } : {}),
                ...(search ? {
                    OR: [
                        { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } },
                        { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                        { inquilinos: { some: { persona: { telefono: { contains: String(search), mode: 'insensitive' } } } } },
                        { propietarios: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
                        { propietarios: { some: { persona: { telefono: { contains: String(search), mode: 'insensitive' } } } } }
                    ]
                } : {})
        };
        const [total, contracts] = await prisma.$transaction([
          prisma.contrato.count({ where }),
          prisma.contrato.findMany({
            where,
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
            orderBy: [{ fechaCreacion: 'desc' }, { id: 'desc' }],
            skip: pagination.skip,
            take: pagination.limit
          })
        ]);
        const canViewFiles = await userHasPermission(userId, role, 'contratos.archivos.ver');
        let data = canViewFiles ? contracts : contracts.map(contract => ({
            ...contract,
            rutaArchivoContrato: null,
            adjuntos: []
        }));
        if (status === 'PAPELERA') {
            data = data.map(contract => ({
                ...contract,
                daysUntilDeletion: contract.eliminadoEn
                    ? Math.max(0, Math.ceil((contract.eliminadoEn.getTime() + TRASH_RETENTION_DAYS * 86_400_000 - Date.now()) / 86_400_000))
                    : TRASH_RETENTION_DAYS
            }));
        }
        res.json({
            data,
            meta: {
                total,
                page: pagination.page,
                limit: pagination.limit,
                totalPages: Math.ceil(total / pagination.limit),
                ...(status === 'PAPELERA' ? { retentionDays: TRASH_RETENTION_DAYS } : {})
            }
        });
    } catch (error) {
        console.error('Error fetching contracts:', error);
        res.status(500).json({ message: 'Error al obtener contratos' });
    }
});

// Get upcoming alerts (updates and expirations)
router.get('/alertas', requirePermission('contratos.ver'), async (req, res) => {
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
                        requiereActualizacion: true,
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

type PersonCandidate = z.infer<typeof personCandidateSchema>;
type PropertyCandidate = z.infer<typeof propertyCandidateSchema>;
type ContractCreateInput = z.infer<typeof contractCreateSchema>;
type TxClient = Prisma.TransactionClient;

const ensureExistingProperty = async (tx: TxClient, inmobiliariaId: number, propiedadId: number) => {
    const propiedad = await tx.propiedad.findFirst({
        where: { id: propiedadId, inmobiliariaId }
    });

    if (!propiedad) {
        throw new AppError('La propiedad seleccionada no existe o no pertenece a la inmobiliaria', {
            statusCode: 400,
            code: 'INVALID_PROPERTY_REFERENCE'
        });
    }

    if (propiedad.estado === 'INACTIVO') {
        throw new AppError('No se puede crear un contrato sobre una propiedad inactiva', {
            statusCode: 409,
            code: 'PROPERTY_INACTIVE'
        });
    }

    return propiedad;
};

const assertPropertyAvailableForPeriod = async (
    tx: TxClient,
    propiedadId: number,
    fechaInicio: Date,
    fechaFin: Date,
    excludeContractId?: number
) => {
    const overlapping = await tx.contrato.findFirst({
        where: {
            propiedadId,
            estado: 'ACTIVO',
            ...(excludeContractId ? { id: { not: excludeContractId } } : {}),
            fechaInicio: { lte: fechaFin },
            fechaFin: { gte: fechaInicio }
        },
        select: { id: true }
    });
    if (overlapping) {
        throw new AppError('La propiedad ya tiene un contrato activo para el período seleccionado', {
            statusCode: 409,
            code: 'PROPERTY_ALREADY_RENTED',
            details: { conflictingContractId: overlapping.id }
        });
    }
};

const syncPropertyState = async (tx: TxClient, propiedadId: number) => {
    const activeContracts = await tx.contrato.count({ where: { propiedadId, estado: 'ACTIVO' } });
    await tx.propiedad.updateMany({
        where: { id: propiedadId, estado: { not: 'INACTIVO' } },
        data: { estado: activeContracts > 0 ? 'ALQUILADO' : 'DISPONIBLE' }
    });
};

const ensureExistingPeople = async (
    tx: TxClient,
    inmobiliariaId: number,
    ids: number[],
    roleLabel: 'propietario' | 'inquilino'
) => {
    const people = await tx.persona.findMany({
        where: {
            id: { in: ids },
            inmobiliariaId
        }
    });

    if (people.length !== ids.length) {
        throw new AppError(`Uno o más ${roleLabel}s seleccionados no existen o no pertenecen a la inmobiliaria`, {
            statusCode: 400,
            code: 'INVALID_PERSON_REFERENCE'
        });
    }

    const peopleById = new Map(people.map(person => [person.id, person.id]));
    return ids.map(id => peopleById.get(id)!);
};

const createPropertyIfNeeded = async (
    tx: TxClient,
    payload: ContractCreateInput,
    inmobiliariaId: number,
    userId: number
) => {
    if (payload.propiedadId) {
        return ensureExistingProperty(tx, inmobiliariaId, payload.propiedadId);
    }

    const propertyInput = payload.propiedad as PropertyCandidate | undefined;
    if (!propertyInput) {
        throw new AppError('Faltan los datos de la propiedad', {
            statusCode: 400,
            code: 'MISSING_PROPERTY_DATA'
        });
    }

    return tx.propiedad.create({
        data: {
            ...propertyInput,
            inmobiliariaId,
            creadoPorId: userId
        }
    });
};

const createPeopleIfNeeded = async (
    tx: TxClient,
    candidates: PersonCandidate[] | undefined,
    legacyIds: number[] | undefined,
    inmobiliariaId: number,
    userId: number,
    roleLabel: 'propietario' | 'inquilino'
) => {
    if (candidates && candidates.length > 0) {
        const resolvedIds: number[] = [];

        for (const candidate of candidates) {
            if (candidate.id) {
                const existing = await tx.persona.findFirst({
                    where: { id: candidate.id, inmobiliariaId }
                });

                if (!existing) {
                    throw new AppError(`El ${roleLabel} seleccionado no existe o no pertenece a la inmobiliaria`, {
                        statusCode: 400,
                        code: 'INVALID_PERSON_REFERENCE'
                    });
                }

                resolvedIds.push(existing.id);
                continue;
            }

            if (candidate.dni) {
                const duplicate = await tx.persona.findFirst({
                    where: { dni: candidate.dni, inmobiliariaId }
                });

                if (duplicate) {
                    throw new AppError(`Ya existe un ${roleLabel} con el DNI ${candidate.dni}`, {
                        statusCode: 409,
                        code: 'PERSON_DUPLICATE_DNI'
                    });
                }
            }

            const created = await tx.persona.create({
                data: {
                    nombreCompleto: candidate.nombreCompleto!,
                    dni: candidate.dni,
                    email: candidate.email,
                    telefono: candidate.telefono,
                    direccion: candidate.direccion,
                    estado: candidate.estado || 'ACTIVO',
                    inmobiliariaId,
                    creadoPorId: userId
                }
            });

            resolvedIds.push(created.id);
        }

        return resolvedIds;
    }

    if (!legacyIds || legacyIds.length === 0) {
        throw new AppError(`Debe indicar al menos un ${roleLabel}`, {
            statusCode: 400,
            code: 'MISSING_CONTRACT_PARTY'
        });
    }

    return ensureExistingPeople(tx, inmobiliariaId, legacyIds, roleLabel);
};

const buildContractCreateError = (error: unknown, req: AuthRequest) => {
    if (error instanceof AppError) {
        return error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
        return new AppError('No se pudo guardar el contrato por un conflicto de datos en la base', {
            statusCode: 409,
            code: 'DATABASE_CONFLICT',
            details: {
                prismaCode: error.code,
                target: error.meta?.target,
                requestId: req.requestId
            }
        });
    }

    if (error instanceof Prisma.PrismaClientValidationError) {
        return new AppError('Los datos del contrato son inválidos para persistir en la base', {
            statusCode: 400,
            code: 'DATABASE_VALIDATION_ERROR',
            details: { requestId: req.requestId }
        });
    }

    return new AppError('Ocurrió un error inesperado al crear el contrato', {
        statusCode: 500,
        code: 'CONTRACT_CREATE_FAILED',
        details: { requestId: req.requestId }
    });
};

// Create contract
router.post('/', requirePermission('contratos.crear'), upload.single('pdf'), validateUploadedFileContent, cleanupFailedUpload, validateBody(contractCreateSchema), async (req, res) => {
    const authReq = req as AuthRequest;
    const { inmobiliariaId, id: userId } = authReq.user!;
    const payload = req.body as ContractCreateInput;
    const updateSettings = normalizeUpdateSettings(payload);

    const contractFilePath = await commitUploadedFile(req.file, inmobiliariaId);

    try {
        const contract = await prisma.$transaction(async (tx) => {
            const propiedad = await createPropertyIfNeeded(tx, payload, inmobiliariaId, userId);
            await assertPropertyAvailableForPeriod(
                tx,
                propiedad.id,
                parseDateOnly(payload.fechaInicio),
                parseDateOnly(payload.fechaFin)
            );
            const propietariosIds = await createPeopleIfNeeded(
                tx,
                payload.propietarios,
                payload.propietarioIds,
                inmobiliariaId,
                userId,
                'propietario'
            );
            const inquilinosIds = await createPeopleIfNeeded(
                tx,
                payload.inquilinos,
                payload.inquilinoIds,
                inmobiliariaId,
                userId,
                'inquilino'
            );

            const newContract = await tx.contrato.create({
                data: {
                    fechaInicio: parseDateOnly(payload.fechaInicio),
                    fechaFin: parseDateOnly(payload.fechaFin),
                    fechaProximaActualizacion: updateSettings.fechaProximaActualizacion,
                    observaciones: payload.observaciones,
                    rutaArchivoContrato: contractFilePath,
                    propiedadId: propiedad.id,
                    inmobiliariaId,
                    montoAlquiler: new Decimal(payload.montoAlquiler || 0),
                    montoHonorarios: new Decimal(payload.montoHonorarios || 0),
                    moneda: resolveMoneda(payload.moneda),
                    porcentajeHonorarios: payload.porcentajeHonorarios ? new Decimal(payload.porcentajeHonorarios) : null,
                    pagaHonorarios: payload.pagaHonorarios || 'INQUILINO',
                    diaVencimiento: payload.diaVencimiento ? Number(payload.diaVencimiento) : 10,
                    porcentajeActualizacion: updateSettings.porcentajeActualizacion,
                    tipoAjuste: updateSettings.tipoAjuste,
                    administrado: Boolean(payload.administrado),
                    requiereActualizacion: updateSettings.requiereActualizacion,
                    creadoPorId: userId,
                    propietarios: {
                        create: propietariosIds.map((id, index) => ({
                            personaId: id,
                            esPrincipal: index === 0
                        }))
                    },
                    inquilinos: {
                        create: inquilinosIds.map((id, index) => ({
                            personaId: id,
                            esPrincipal: index === 0
                        }))
                    }
                }
            });

            await syncPropertyState(tx, propiedad.id);

            if (payload.honorarioInicial && Number(payload.honorarioInicial) > 0) {
                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Honorarios por Alta de Contrato - ${propiedad.direccion}`,
                        monto: new Decimal(payload.honorarioInicial),
                            moneda: resolveMoneda(payload.moneda),
                        fecha: new Date(), // Utilizamos la fecha actual de cobro
                        creadoPorId: userId,
                        contratoId: newContract.id,
                        metodoPago: payload.honorarioInicialMetodoPago || 'EFECTIVO'
                    }
                });
            }

            return { newContract, propiedad };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId: userId,
            inmobiliariaId,
            accion: 'CREAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: contract.newContract.id,
            detalle: `Contrato creado para propiedad: ${contract.propiedad.direccion}`
        });

        res.status(201).json(contract.newContract);
    } catch (error) {
        const appError = buildContractCreateError(error, authReq);
        logger.error('Error creating contract', {
            requestId: authReq.requestId,
            inmobiliariaId,
            userId,
            code: appError.code,
            error
        });

        res.status(appError.statusCode).json({
            message: appError.message,
            code: appError.code,
            details: appError.details,
            requestId: authReq.requestId
        });
    }
});

// Get contract details
router.get('/:id', requirePermission('contratos.ver'), async (req, res) => {
    const { id: userId, role, inmobiliariaId } = (req as AuthRequest).user!;
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

        const canViewFiles = await userHasPermission(userId, role, 'contratos.archivos.ver');

        res.json({
            ...contract,
            rutaArchivoContrato: canViewFiles ? contract.rutaArchivoContrato : null,
            adjuntos: canViewFiles ? contract.adjuntos : [],
            auditLogs
        });
    } catch (error) {
        res.status(500).json({ message: 'Error al obtener contrato' });
    }
});

// Add attachment
router.post('/:id/adjuntos', requirePermission('contratos.editar'), upload.single('archivo'), validateUploadedFileContent, cleanupFailedUpload, async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreArchivo } = req.body;

    if (!req.file) {
        return res.status(400).json({ message: 'No se subió ningún archivo' });
    }

    const filePath = await commitUploadedFile(req.file, inmobiliariaId);

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const attachment = await prisma.adjuntoContrato.create({
            data: {
                rutaArchivo: filePath!,
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
router.delete('/:id', requirePermission('contratos.eliminar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        await prisma.$transaction(async tx => {
            await tx.contrato.update({
                where: { id: Number(id) },
                data: {
                    estadoAnteriorPapelera: contract.estado === 'PAPELERA' ? contract.estadoAnteriorPapelera : contract.estado,
                    estado: 'PAPELERA',
                    eliminadoEn: new Date(),
                    actualizadoPorId: (req as AuthRequest).user!.id
                }
            });
            await syncPropertyState(tx, contract.propiedadId);
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
router.post('/:id/restaurar', requirePermission('contratos.restaurar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        if (contract.estado !== 'PAPELERA') {
            return res.status(409).json({ message: 'Solo se pueden restaurar contratos que estén en la papelera' });
        }

        const restoredState = contract.estadoAnteriorPapelera && contract.estadoAnteriorPapelera !== 'PAPELERA'
            ? contract.estadoAnteriorPapelera
            : 'ACTIVO';

        await prisma.$transaction(async tx => {
            if (restoredState === 'ACTIVO') {
                await assertPropertyAvailableForPeriod(tx, contract.propiedadId, contract.fechaInicio, contract.fechaFin, contract.id);
            }
            await tx.contrato.update({
                where: { id: Number(id) },
                data: {
                    estado: restoredState,
                    estadoAnteriorPapelera: null,
                    eliminadoEn: null,
                    actualizadoPorId: (req as AuthRequest).user!.id
                }
            });
            await syncPropertyState(tx, contract.propiedadId);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'RESTAURAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id)
        });

        res.json({ message: 'Contrato restaurado con éxito' });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code });
        }
        res.status(500).json({ message: 'Error al restaurar contrato' });
    }
});

// Permanent delete
router.delete('/:id/permanente', requirePermission('contratos.eliminar'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const result = await deleteContractPermanently(Number(id), inmobiliariaId);
        
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'ELIMINAR_PERMANENTE_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: 'Eliminación definitiva del contrato'
        });

        res.json({ message: 'Contrato eliminado permanentemente', ...result });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        res.status(500).json({ message: 'Error al eliminar contrato permanentemente' });
    }
});

// Update status
router.patch('/:id/estado', requirePermission('contratos.editar'), validateBody(contractStatusSchema), async (req, res) => {
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

        await prisma.$transaction(async tx => {
            if (estado === 'ACTIVO') {
                await assertPropertyAvailableForPeriod(tx, contract.propiedadId, contract.fechaInicio, contract.fechaFin, contract.id);
            }
            await tx.contrato.update({
                where: { id: Number(id) },
                data: { estado, actualizadoPorId: (req as AuthRequest).user!.id }
            });
            await syncPropertyState(tx, contract.propiedadId);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

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
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code });
        }
        res.status(500).json({ message: 'Error al actualizar estado del contrato' });
    }
});

// Update contract
router.put('/:id', requirePermission('contratos.editar'), upload.single('pdf'), validateUploadedFileContent, cleanupFailedUpload, validateBody(contractUpdateSchema), async (req, res) => {
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
        administrado,
        requiereActualizacion,
        moneda
    } = req.body;

    const uploadedFilePath = await commitUploadedFile(req.file, inmobiliariaId);

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
        const updatesScheduling = requiereActualizacion !== undefined;
        if (updatesScheduling && !requiereActualizacion) {
            updateData.requiereActualizacion = false;
            updateData.fechaProximaActualizacion = null;
            updateData.porcentajeActualizacion = null;
            updateData.tipoAjuste = null;
            changes.requiereActualizacion = { anterior: contract.requiereActualizacion, nuevo: updateData.requiereActualizacion };
            changes.fechaProximaActualizacion = { anterior: contract.fechaProximaActualizacion, nuevo: updateData.fechaProximaActualizacion };
            changes.porcentajeActualizacion = { anterior: contract.porcentajeActualizacion, nuevo: updateData.porcentajeActualizacion };
            changes.tipoAjuste = { anterior: contract.tipoAjuste, nuevo: updateData.tipoAjuste };
        } else if (updatesScheduling && requiereActualizacion) {
            const nextUpdateDate = fechaActualizacion ? parseDateOnly(fechaActualizacion) : contract.fechaProximaActualizacion;
            if (!nextUpdateDate) {
                return res.status(400).json({ message: 'La próxima actualización es obligatoria si el contrato tiene actualización programada.' });
            }

            updateData.requiereActualizacion = true;
            updateData.fechaProximaActualizacion = nextUpdateDate;
            updateData.porcentajeActualizacion = porcentajeActualizacion !== undefined
                ? (porcentajeActualizacion ? new Decimal(porcentajeActualizacion) : null)
                : contract.porcentajeActualizacion;
            updateData.tipoAjuste = tipoAjuste !== undefined ? (tipoAjuste || null) : contract.tipoAjuste;
            changes.requiereActualizacion = { anterior: contract.requiereActualizacion, nuevo: updateData.requiereActualizacion };
            changes.fechaProximaActualizacion = { anterior: contract.fechaProximaActualizacion, nuevo: updateData.fechaProximaActualizacion };
            changes.porcentajeActualizacion = { anterior: contract.porcentajeActualizacion, nuevo: updateData.porcentajeActualizacion };
            changes.tipoAjuste = { anterior: contract.tipoAjuste, nuevo: updateData.tipoAjuste };
        } else if (fechaActualizacion !== undefined) {
            updateData.fechaProximaActualizacion = fechaActualizacion ? parseDateOnly(fechaActualizacion) : null;
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
        if (moneda && moneda !== contract.moneda) {
            const [liquidaciones, pagos, movimientosCaja, planesCuotas] = await Promise.all([
                prisma.liquidacion.count({ where: { contratoId: contract.id } }),
                prisma.pago.count({ where: { contratoId: contract.id } }),
                prisma.movimientoCaja.count({ where: { contratoId: contract.id } }),
                prisma.planCuotas.count({ where: { contratoId: contract.id } })
            ]);

            if (liquidaciones > 0 || pagos > 0 || movimientosCaja > 0 || planesCuotas > 0) {
                return res.status(400).json({
                    message: 'No se puede cambiar la moneda del contrato porque ya tiene liquidaciones, pagos, movimientos de caja o planes de cuotas asociados.'
                });
            }

            updateData.moneda = moneda;
            changes.moneda = { anterior: contract.moneda, nuevo: moneda };
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
        if (!updatesScheduling && porcentajeActualizacion !== undefined) {
            updateData.porcentajeActualizacion = porcentajeActualizacion ? new Decimal(porcentajeActualizacion) : null;
            changes.porcentajeActualizacion = { anterior: contract.porcentajeActualizacion, nuevo: updateData.porcentajeActualizacion };
        }
        if (!updatesScheduling && tipoAjuste !== undefined) {
            updateData.tipoAjuste = tipoAjuste || null;
            changes.tipoAjuste = { anterior: contract.tipoAjuste, nuevo: updateData.tipoAjuste };
        }
        if (administrado !== undefined) {
            updateData.administrado = administrado === 'true' || administrado === true;
            changes.administrado = { anterior: contract.administrado, nuevo: updateData.administrado };
        }
        if (uploadedFilePath) {
            updateData.rutaArchivoContrato = uploadedFilePath;
            changes.rutaArchivoContrato = { anterior: contract.rutaArchivoContrato, nuevo: updateData.rutaArchivoContrato };
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
        
        if (uploadedFilePath && contract.rutaArchivoContrato && contract.rutaArchivoContrato !== uploadedFilePath) {
            await removeUploadedFile(contract.rutaArchivoContrato);
        }

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
router.post('/:id/actualizar', requirePermission('contratos.editar'), validateBody(contractRentUpdateSchema), async (req, res) => {
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

        if (!contrato.requiereActualizacion) {
            return res.status(400).json({ message: 'Este contrato no tiene actualización de alquiler programada.' });
        }

        const result = await prisma.$transaction(async (tx) => {
            // 1. Crear registro de historia
            await tx.actualizacionContrato.create({
                data: {
                    contratoId: Number(id),
                    montoAnterior: contrato.montoAlquiler,
                    montoNuevo: new Decimal(montoNuevo),
                    moneda: contrato.moneda,
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
            detalle: `Actualización de monto de alquiler: ${formatCurrency(contrato.montoAlquiler.toString(), contrato.moneda)} -> ${formatCurrency(montoNuevo, contrato.moneda)}`
        });

        res.json(result);
    } catch (error) {
        console.error('Error al actualizar monto de contrato:', error);
        res.status(500).json({ message: 'Error al actualizar contrato' });
    }
});

export default router;

