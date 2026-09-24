import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { validateBody, requiredText, optionalText, optionalEmail, optionalPhone, optionalDni, optionalCuit, optionalCbu, optionalBankAlias, optionalBooleanFromForm } from '../middlewares/validation.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';
import {
    isPersonDniUniqueConflict,
    PERSON_DUPLICATE_DNI_CODE,
    PERSON_DUPLICATE_DNI_MESSAGE
} from '../utils/person-dni';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate, optimisticVersionSchema } from '../utils/optimistic-lock';
import { withPagination } from '../middlewares/pagination.middleware';
import {
    assertPersonIdentityAvailable,
    findPersonIdentityMatches,
    getPersonIdentity,
    isPersonIdentityUniqueConflict,
    PERSON_IDENTITY_DUPLICATE_CODE,
    PERSON_IDENTITY_DUPLICATE_MESSAGE
} from '../utils/person-identity';
import { mergePeople } from '../services/person-merge.service';
import { normalizeBankAlias, normalizeCbu } from '../utils/bank-account';

const router = Router();

router.use(authenticateToken);

const personaSchema = z.object({
    nombreCompleto: requiredText('El nombre completo', 140),
    dni: optionalDni(),
    email: optionalEmail(),
    telefono: optionalPhone(),
    direccion: optionalText(180),
    cuit: optionalCuit(),
    banco: optionalText(100),
    cbu: optionalCbu(),
    aliasBancario: optionalBankAlias(),
    titularCuentaBancaria: optionalText(140),
    titularidadBancariaVerificada: optionalBooleanFromForm.default(false),
    contactoAlternativo: optionalText(140), telefonoAlternativo: optionalPhone(),
    estado: z.enum(['ACTIVO', 'INACTIVO']).optional().default('ACTIVO')
}).superRefine((data, ctx) => {
    const hasBankDestination = Boolean(data.cbu || data.aliasBancario);
    if (hasBankDestination && !data.titularidadBancariaVerificada) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['titularidadBancariaVerificada'],
            message: 'Confirmá que verificaste la titularidad de la cuenta antes de guardar datos bancarios'
        });
    }
    if (!hasBankDestination && data.titularidadBancariaVerificada) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['titularidadBancariaVerificada'],
            message: 'No podés confirmar titularidad sin informar un CBU o alias'
        });
    }
});
const personaUpdateSchema = personaSchema.extend({ version: optimisticVersionSchema });
const identityQuerySchema = z.object({
    dni: optionalDni(),
    cuit: optionalCuit(),
    email: optionalEmail(),
    telefono: optionalPhone(),
    excluirId: z.coerce.number().int().positive().optional()
}).refine(value => Boolean(value.dni || value.cuit || value.email || value.telefono), {
    message: 'Indicá al menos DNI, CUIT, correo electrónico o teléfono'
});
const mergeSchema = z.object({
    personaDestinoId: z.coerce.number().int().positive(),
    version: optimisticVersionSchema,
    motivo: requiredText('El motivo de la fusión', 1000).refine(value => value.length >= 5, 'El motivo de la fusión debe tener al menos 5 caracteres')
}).strict();

// Get all persons with their computed roles
router.get('/', requirePermission('personas.ver'), withPagination(25), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { search, id } = req.query;
    const pagination = res.locals.pagination;

    try {
        const searchTerm = String(search || '').trim();
        const normalizedCbu = searchTerm ? normalizeCbu(searchTerm) : '';
        const normalizedAlias = searchTerm ? normalizeBankAlias(searchTerm) : '';
        const where = {
            inmobiliariaId,
            ...(Number.isInteger(Number(id)) && Number(id) > 0 ? { id: Number(id) } : {}),
            ...(searchTerm ? {
                OR: [
                    { nombreCompleto: { contains: searchTerm, mode: 'insensitive' as const } },
                    { dni: { contains: searchTerm, mode: 'insensitive' as const } },
                    { cuit: { contains: searchTerm, mode: 'insensitive' as const } },
                    { email: { contains: searchTerm, mode: 'insensitive' as const } },
                    { telefono: { contains: searchTerm, mode: 'insensitive' as const } },
                    ...(normalizedCbu ? [{ cbu: { contains: normalizedCbu } }] : []),
                    ...(normalizedAlias ? [{ aliasBancario: { contains: normalizedAlias, mode: 'insensitive' as const } }] : [])
                ]
            } : {})
        };
        const [total, personas] = await prisma.$transaction([
          prisma.persona.count({ where }),
          prisma.persona.findMany({
            where: {
                ...where
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
            orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }],
            skip: pagination.skip,
            take: pagination.limit
          })
        ]);

        // Map to include roles
        const data = personas.map(p => ({
            ...p,
            roles: [
                p._count.contratosPropietario > 0 ? 'Propietario' : null,
                p._count.contratosInquilino > 0 ? 'Inquilino' : null,
                p._count.contratosGarante > 0 ? 'Garante' : null
            ].filter(Boolean)
        }));

        res.json({
            data,
            meta: { total, page: pagination.page, limit: pagination.limit, totalPages: Math.ceil(total / pagination.limit) }
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Error al obtener personas' });
    }
});

// Shows candidate records before a person is created or its identity fields are changed.
router.get('/coincidencias', requirePermission('personas.ver'), async (req, res) => {
    const parsed = identityQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        return res.status(400).json({
            message: 'Datos de consulta inválidos',
            errors: parsed.error.issues.map(issue => ({ field: issue.path.join('.'), message: issue.message }))
        });
    }
    try {
        const { inmobiliariaId } = (req as AuthRequest).user!;
        const { excluirId, ...identity } = parsed.data;
        const coincidencias = await findPersonIdentityMatches(prisma, inmobiliariaId, identity, excluirId);
        res.json({ coincidencias });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'No se pudieron revisar las coincidencias de la persona' });
    }
});

// Create person
router.post('/', requirePermission('personas.crear'), validateBody(personaSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { nombreCompleto, dni, email, telefono, direccion, estado, cuit, banco, cbu, aliasBancario, titularCuentaBancaria, titularidadBancariaVerificada, contactoAlternativo, telefonoAlternativo } = req.body;

    try {
        await assertPersonIdentityAvailable(prisma, inmobiliariaId, { dni, cuit, email, telefono });
        const identity = getPersonIdentity({ dni, cuit, email, telefono });

        const persona = await prisma.persona.create({
            data: {
                nombreCompleto,
                dni,
                email,
                telefono,
                cuitNormalizado: identity.cuitNormalizado || null,
                emailNormalizado: identity.emailNormalizado || null,
                telefonoNormalizado: identity.telefonoNormalizado || null,
                direccion,
                cuit, banco, cbu, aliasBancario, titularCuentaBancaria, titularidadBancariaVerificada, contactoAlternativo, telefonoAlternativo,
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
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        if (isPersonDniUniqueConflict(error)) {
            return res.status(409).json({
                message: PERSON_DUPLICATE_DNI_MESSAGE,
                code: PERSON_DUPLICATE_DNI_CODE
            });
        }
        if (isPersonIdentityUniqueConflict(error)) {
            return res.status(409).json({ message: PERSON_IDENTITY_DUPLICATE_MESSAGE, code: PERSON_IDENTITY_DUPLICATE_CODE });
        }
        console.error(error);
        res.status(500).json({ message: 'Error al crear persona' });
    }
});

// Update person
router.put('/:id', requirePermission('personas.editar'), validateBody(personaUpdateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreCompleto, dni, email, telefono, direccion, estado, version, cuit, banco, cbu, aliasBancario, titularCuentaBancaria, titularidadBancariaVerificada, contactoAlternativo, telefonoAlternativo } = req.body;

    try {
        const existing = await prisma.persona.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!existing) {
            return res.status(404).json({ message: 'Persona no encontrada' });
        }

        if (existing.version !== version) {
            assertOptimisticUpdate(0, version, existing.version);
        }

        await assertPersonIdentityAvailable(prisma, inmobiliariaId, { dni, cuit, email, telefono }, existing.id);
        const identity = getPersonIdentity({ dni, cuit, email, telefono });

        const persona = await prisma.$transaction(async tx => {
            const result = await tx.persona.updateMany({
                where: { id: Number(id), inmobiliariaId, version },
                data: {
                    nombreCompleto,
                    dni,
                    email,
                    telefono,
                    cuitNormalizado: identity.cuitNormalizado || null,
                    emailNormalizado: identity.emailNormalizado || null,
                    telefonoNormalizado: identity.telefonoNormalizado || null,
                    direccion,
                    cuit, banco, cbu, aliasBancario, titularCuentaBancaria, titularidadBancariaVerificada, contactoAlternativo, telefonoAlternativo,
                    estado,
                    actualizadoPorId: (req as AuthRequest).user!.id,
                    version: { increment: 1 }
                }
            });
            const currentVersion = result.count === 0
                ? (await tx.persona.findFirst({ where: { id: Number(id), inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(result.count, version, currentVersion);
            return tx.persona.findUniqueOrThrow({ where: { id: Number(id) } });
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
                cuit: { anterior: existing.cuit, nuevo: persona.cuit },
                cbu: { anterior: existing.cbu, nuevo: persona.cbu },
                aliasBancario: { anterior: existing.aliasBancario, nuevo: persona.aliasBancario },
                titularCuentaBancaria: { anterior: existing.titularCuentaBancaria, nuevo: persona.titularCuentaBancaria },
                titularidadBancariaVerificada: { anterior: existing.titularidadBancariaVerificada, nuevo: persona.titularidadBancariaVerificada },
                direccion: { anterior: existing.direccion, nuevo: persona.direccion },
                estado: { anterior: existing.estado, nuevo: persona.estado }
            })
        });

        res.json(persona);
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        if (isPersonDniUniqueConflict(error)) {
            return res.status(409).json({
                message: PERSON_DUPLICATE_DNI_MESSAGE,
                code: PERSON_DUPLICATE_DNI_CODE
            });
        }
        if (isPersonIdentityUniqueConflict(error)) {
            return res.status(409).json({ message: PERSON_IDENTITY_DUPLICATE_MESSAGE, code: PERSON_IDENTITY_DUPLICATE_CODE });
        }
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar persona' });
    }
});

/**
 * Reassigns all operational links to the selected canonical person and removes
 * the duplicate. It intentionally keeps a critical audit record for both IDs.
 */
router.post('/:id/fusionar', requirePermission('personas.editar'), requireRecentAuthentication, validateBody(mergeSchema), async (req, res) => {
    const sourceId = Number(req.params.id);
    if (!Number.isInteger(sourceId) || sourceId <= 0) return res.status(400).json({ message: 'ID de persona inválido' });
    const user = (req as AuthRequest).user!;
    try {
        const result = await mergePeople({
            inmobiliariaId: user.inmobiliariaId,
            sourceId,
            targetId: req.body.personaDestinoId,
            sourceVersion: req.body.version,
            userId: user.id
        });
        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'FUSIONAR_PERSONAS',
            entidad: 'Persona',
            entidadId: result.destinoId,
            severidad: 'CRITICAL',
            detalle: JSON.stringify({ origen: result.origen, destino: result.destino, motivo: req.body.motivo, relaciones: result.relaciones })
        });
        res.json({ message: 'Personas fusionadas correctamente', ...result });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        console.error(error);
        res.status(500).json({ message: 'No se pudieron fusionar las personas' });
    }
});

// Delete person (soft delete if enforced, or hard delete)
// Requirement says "Estado (activo / inactivo)", so maybe we just toggle status?
// But usually there is a delete button too.
// If contracts exist, hard delete will fail due to foreign keys.
router.delete('/:id', requirePermission('personas.eliminar'), async (req, res) => {
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
