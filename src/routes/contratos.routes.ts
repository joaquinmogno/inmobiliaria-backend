import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { cleanupFailedUpload, commitUploadedFile, removeUploadedFile, upload, validateUploadedFileContent } from '../middlewares/upload.middleware';
import { Decimal } from '@prisma/client/runtime/library';
import { auditService } from '../services/audit.service';
import { validateBody } from '../middlewares/validation.middleware';
import { Prisma, TipoDocumentoContrato } from '@prisma/client';
import { logger } from '../services/logger.service';
import { AppError } from '../errors/app-error';
import { requirePermission } from '../middlewares/permissions.middleware';
import { formatCurrency } from '../utils/currency';
import { resolveMoneda } from '../services/currency-rules.service';
import { deleteContractPermanently } from '../services/contract-deletion.service';
import {
    assertContractCanBeRescinded,
    getContractFinancialHistory,
    getContractOutstandingObligations,
    hasContractFinancialHistory,
    hasContractOutstandingObligations
} from '../services/contract-financial-integrity.service';
import {
    getContractStateForDates,
    syncPropertyOccupancy
} from '../services/contract-lifecycle.service';
import { argentinaTodayAsDate, parseDateOnly } from '../utils/argentina-date';
import { assertCashPeriodOpen } from '../services/cash-closing.service';
import { assertOptimisticUpdate } from '../utils/optimistic-lock';
import {
    contractAttachmentSchema,
    contractCreateSchema,
    contractRentUpdateSchema,
    contractRescissionSchema,
    contractUpdateSchema,
    normalizeContractUpdateSettings,
    type ContractCreateInput
} from '../validation/contratos.schemas';
import {
    assertPropertyAvailableForPeriod,
    buildContractCreateError,
    createPeopleIfNeeded,
    createPropertyIfNeeded,
    ensureExistingProperty,
    assertUniqueContractParties
} from '../services/contract-write.service';
import { createPrincipalContractDocument } from '../services/contract-document-version.service';
import { assertValidContractRenewal } from '../services/contract-renewal.service';
import contractQueryRouter from './contratos-query.routes';
import contractDraftRouter from './contratos-drafts.routes';

const router = Router();

router.use(authenticateToken);
router.use('/borradores', contractDraftRouter);
router.use(contractQueryRouter);


function compactChanges(changes: Record<string, { anterior: unknown; nuevo: unknown }>) {
    return JSON.stringify(changes, (_key, value) => {
        if (value instanceof Decimal) return value.toString();
        if (value instanceof Date) return value.toISOString().slice(0, 10);
        return value;
    });
}

async function assertAgreedCollectionAccount(tx: Prisma.TransactionClient, accountId: number | null | undefined, inmobiliariaId: number, moneda: 'ARS' | 'USD') {
    if (!accountId) return;
    const account = await tx.cuentaBancaria.findFirst({ where: { id: accountId, inmobiliariaId, moneda, activa: true }, select: { id: true } });
    if (!account) throw new AppError('La cuenta de cobro acordada debe estar activa y usar la moneda del contrato', { statusCode: 400, code: 'INVALID_AGREED_COLLECTION_ACCOUNT' });
}

// Create contract
router.post('/', requirePermission('contratos.crear'), upload.single('pdf'), validateUploadedFileContent, cleanupFailedUpload, validateBody(contractCreateSchema), async (req, res) => {
    const authReq = req as AuthRequest;
    const { inmobiliariaId, id: userId } = authReq.user!;
    const payload = req.body as ContractCreateInput;
    const updateSettings = normalizeContractUpdateSettings(payload);
    const fechaInicio = parseDateOnly(payload.fechaInicio);
    const fechaFin = parseDateOnly(payload.fechaFin);

    const contractFilePath = await commitUploadedFile(req.file, inmobiliariaId);

    try {
        const contract = await prisma.$transaction(async (tx) => {
            const draft = payload.borradorId ? await tx.borradorContrato.findFirst({
                where: {
                    id: payload.borradorId,
                    inmobiliariaId,
                    ...(authReq.user!.tipo === 'ADMIN' ? {} : { creadoPorId: userId })
                },
                include: { adjuntos: { orderBy: { id: 'asc' } } }
            }) : null;
            if (payload.borradorId && !draft) {
                throw Object.assign(new Error('El borrador no existe o ya fue utilizado.'), { statusCode: 404, code: 'DRAFT_NOT_FOUND' });
            }
            const draftPrincipal = draft?.adjuntos.find(attachment => attachment.tipo === TipoDocumentoContrato.CONTRATO_PRINCIPAL);
            const principalFilePath = contractFilePath || draftPrincipal?.rutaArchivo || null;
            const propiedad = await createPropertyIfNeeded(tx, payload, inmobiliariaId, userId);
            await assertPropertyAvailableForPeriod(
                tx,
                propiedad.id,
                fechaInicio,
                fechaFin
            );
            const contratoAnterior = await assertValidContractRenewal(tx, {
                contratoAnteriorId: payload.contratoAnteriorId,
                inmobiliariaId,
                propiedadId: propiedad.id,
                fechaInicio
            });
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
            assertUniqueContractParties(propietariosIds, inquilinosIds);
            await assertAgreedCollectionAccount(tx, payload.cuentaCobroAcordadaId, inmobiliariaId, resolveMoneda(payload.moneda));

            const newContract = await tx.contrato.create({
                data: {
                    fechaInicio,
                    fechaFin,
                    estado: getContractStateForDates(
                        fechaInicio,
                        fechaFin
                    ),
                    fechaProximaActualizacion: updateSettings.fechaProximaActualizacion,
                    observaciones: payload.observaciones,
                    rutaArchivoContrato: principalFilePath,
                    propiedadId: propiedad.id,
                    inmobiliariaId,
                    montoAlquiler: new Decimal(payload.montoAlquiler || 0),
                    montoHonorarios: new Decimal(payload.montoHonorarios || 0),
                    moneda: resolveMoneda(payload.moneda),
                    porcentajeHonorarios: new Decimal(payload.porcentajeHonorarios ?? 5),
                    pagaHonorarios: 'PROPIETARIO',
                    diaVencimiento: payload.diaVencimiento ? Number(payload.diaVencimiento) : 10,
                    modalidadCobroInquilino: payload.modalidadCobroInquilino || null,
                    modalidadPagoPropietario: payload.modalidadPagoPropietario || null,
                    cuentaCobroAcordadaId: payload.modalidadCobroInquilino === 'TRANSFERENCIA' ? payload.cuentaCobroAcordadaId || null : null,
                    porcentajeActualizacion: updateSettings.porcentajeActualizacion,
                    tipoAjuste: updateSettings.tipoAjuste,
                    administrado: Boolean(payload.administrado),
                    requiereActualizacion: updateSettings.requiereActualizacion,
                    creadoPorId: userId,
                    contratoAnteriorId: contratoAnterior?.id,
                    ...(payload.serviciosGastos?.length ? {
                        serviciosGastos: {
                            create: payload.serviciosGastos.map((servicioGasto, index) => ({
                                concepto: servicioGasto.concepto,
                                responsable: servicioGasto.responsable,
                                orden: index
                            }))
                        }
                    } : {}),
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

            if (contractFilePath) {
                await createPrincipalContractDocument(tx, {
                    contratoId: newContract.id,
                    rutaArchivo: contractFilePath,
                    nombreArchivo: req.file?.originalname,
                    observacion: payload.observacionDocumento,
                    creadoPorId: userId
                });
            } else if (draftPrincipal) {
                await createPrincipalContractDocument(tx, {
                    contratoId: newContract.id,
                    rutaArchivo: draftPrincipal.rutaArchivo,
                    nombreArchivo: draftPrincipal.nombreArchivo,
                    creadoPorId: draftPrincipal.creadoPorId || userId
                });
            }

            if (draft) {
                const attachmentsToCarry = draft.adjuntos.filter(attachment =>
                    attachment.tipo !== TipoDocumentoContrato.CONTRATO_PRINCIPAL || Boolean(contractFilePath)
                );
                if (attachmentsToCarry.length) {
                    await tx.adjuntoContrato.createMany({
                        data: attachmentsToCarry.map(attachment => ({
                            contratoId: newContract.id,
                            rutaArchivo: attachment.rutaArchivo,
                            nombreArchivo: attachment.nombreArchivo,
                            tipo: attachment.tipo === TipoDocumentoContrato.CONTRATO_PRINCIPAL
                                ? TipoDocumentoContrato.ADJUNTO
                                : attachment.tipo,
                            fechaDocumento: argentinaTodayAsDate(),
                            esVigente: false,
                            creadoPorId: attachment.creadoPorId || userId
                        }))
                    });
                }
                await tx.borradorContrato.delete({ where: { id: draft.id } });
            }

            await syncPropertyOccupancy(tx, [propiedad.id]);

            if (payload.honorarioInicial && Number(payload.honorarioInicial) > 0) {
                const initialFeePaymentMethod = payload.honorarioInicialMetodoPago || 'EFECTIVO';
                const initialFeeDate = argentinaTodayAsDate();
                const initialFeeAccount = initialFeePaymentMethod === 'EFECTIVO' ? 'CAJA' : 'BANCO';
                // El honorario de alta es un cobro puntual: puede estar en una
                // moneda distinta al alquiler mensual del contrato.
                const initialFeeCurrency = resolveMoneda(payload.monedaHonorarioInicial ?? payload.moneda);
                const initialFeeBankAccount = initialFeeAccount === 'CAJA' ? null : await tx.cuentaBancaria.findFirst({
                    where: { id: payload.honorarioInicialCuentaBancariaId, inmobiliariaId, activa: true, moneda: initialFeeCurrency },
                    select: { id: true }
                });
                if (initialFeeAccount === 'BANCO' && !initialFeeBankAccount) {
                    throw Object.assign(new Error('Seleccioná una cuenta bancaria activa y de la misma moneda para el honorario inicial.'), { statusCode: 400, code: 'BANK_ACCOUNT_REQUIRED' });
                }
                await assertCashPeriodOpen(tx, {
                    inmobiliariaId,
                    fecha: initialFeeDate,
                    cuenta: initialFeeAccount,
                    moneda: initialFeeCurrency,
                    cuentaBancariaId: initialFeeBankAccount?.id
                });
                await tx.movimientoCaja.create({
                    data: {
                        inmobiliariaId,
                        tipo: 'INGRESO',
                        concepto: `Honorarios por Alta de Contrato - ${propiedad.direccion}`,
                        monto: new Decimal(payload.honorarioInicial),
                        moneda: initialFeeCurrency,
                        fecha: initialFeeDate,
                        creadoPorId: userId,
                        contratoId: newContract.id,
                        metodoPago: initialFeePaymentMethod,
                        cuenta: initialFeeAccount,
                        cuentaBancariaId: initialFeeBankAccount?.id
                    }
                });
            }

            return { newContract, propiedad, contratoAnterior };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId: userId,
            inmobiliariaId,
            accion: 'CREAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: contract.newContract.id,
            detalle: contract.contratoAnterior
                ? `Contrato creado como renovación del contrato #${contract.contratoAnterior.id} para propiedad: ${contract.propiedad.direccion}`
                : `Contrato creado${payload.borradorId ? ` desde borrador #${payload.borradorId}` : ''} para propiedad: ${contract.propiedad.direccion}`
        });

        res.status(201).json(contract.newContract);
    } catch (error) {
        const appError = buildContractCreateError(error, authReq.requestId);
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

// Add attachment
router.post('/:id/adjuntos', requirePermission('contratos.editar'), upload.single('archivo'), validateUploadedFileContent, cleanupFailedUpload, validateBody(contractAttachmentSchema), async (req, res) => {
    const { inmobiliariaId, id: userId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { nombreArchivo, tipo, fechaDocumento, observacion } = req.body;

    if (!req.file) {
        return res.status(400).json({ message: 'No se subió ningún archivo' });
    }

    const filePath = await commitUploadedFile(req.file, inmobiliariaId);
    let attachmentCreated = false;

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contract) {
            await removeUploadedFile(filePath);
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        const attachment = await prisma.adjuntoContrato.create({
            data: {
                rutaArchivo: filePath!,
                nombreArchivo: nombreArchivo || req.file.originalname,
                contratoId: Number(id),
                tipo: tipo === 'ADENDA' ? TipoDocumentoContrato.ADENDA : TipoDocumentoContrato.ADJUNTO,
                fechaDocumento: fechaDocumento ? parseDateOnly(fechaDocumento) : argentinaTodayAsDate(),
                observacion: observacion || null,
                creadoPorId: userId
            }
        });
        attachmentCreated = true;

        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'AGREGAR_ADJUNTO_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: `${attachment.tipo === TipoDocumentoContrato.ADENDA ? 'Adenda' : 'Adjunto'} agregado: ${attachment.nombreArchivo || req.file.originalname}`
        });

        res.status(201).json(attachment);
    } catch (error) {
        if (!attachmentCreated) await removeUploadedFile(filePath);
        res.status(500).json({ message: 'Error al subir adjunto' });
    }
});

// Soft delete (Move to trash)
router.delete('/:id', requirePermission('contratos.eliminar'), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const { id } = req.params;

    try {
        const contract = await prisma.$transaction(async tx => {
            const current = await tx.contrato.findFirst({ where: { id: Number(id), inmobiliariaId } });
            if (!current) throw new AppError('Contrato no encontrado', { statusCode: 404, code: 'CONTRACT_NOT_FOUND' });
            if (current.estado === 'PAPELERA') throw new AppError('El contrato ya está en la papelera', { statusCode: 409, code: 'CONTRACT_ALREADY_IN_TRASH' });

            const [history, obligations] = await Promise.all([
                getContractFinancialHistory(tx, current.id),
                getContractOutstandingObligations(tx, current.id)
            ]);
            if (hasContractFinancialHistory(history) || hasContractOutstandingObligations(obligations)) {
                throw new AppError('El contrato tiene historial financiero u obligaciones pendientes y no puede enviarse a la papelera. Usá la rescisión con motivo después de regularizar los saldos.', {
                    statusCode: 409,
                    code: 'CONTRACT_REQUIRES_RESCISSION',
                    details: { history, obligations }
                });
            }

            await tx.contrato.update({
                where: { id: current.id },
                data: {
                    estadoAnteriorPapelera: current.estado,
                    estado: 'PAPELERA',
                    eliminadoEn: new Date(),
                    actualizadoPorId: usuarioId,
                    version: { increment: 1 }
                }
            });
            await syncPropertyOccupancy(tx, [current.propiedadId]);
            return current;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'ELIMINAR_CONTRATO',
            entidad: 'Contrato',
            entidadId: Number(id),
            detalle: 'Contrato movido a la papelera'
        });

        res.json({ message: 'Contrato movido a la papelera' });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        res.status(500).json({ message: 'Error al eliminar contrato' });
    }
});

// La rescisión conserva el vínculo contractual y su trazabilidad. No sustituye
// pagos, liquidaciones ni planes pendientes: éstos deben regularizarse antes.
router.post('/:id/rescindir', requirePermission('contratos.editar'), requireRecentAuthentication, validateBody(contractRescissionSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    const contractId = Number(req.params.id);
    const { motivo, fechaRescision, version } = req.body;

    try {
        const updated = await prisma.$transaction(async tx => {
            const contract = await tx.contrato.findFirst({ where: { id: contractId, inmobiliariaId } });
            if (!contract) throw new AppError('Contrato no encontrado', { statusCode: 404, code: 'CONTRACT_NOT_FOUND' });
            if (contract.version !== version) assertOptimisticUpdate(0, version, contract.version);
            if (contract.estado === 'PAPELERA') throw new AppError('Restaurá el contrato antes de rescindirlo', { statusCode: 409, code: 'CONTRACT_IN_TRASH' });
            if (contract.estado === 'RESCINDIDO') throw new AppError('El contrato ya fue rescindido', { statusCode: 409, code: 'CONTRACT_ALREADY_RESCINDED' });
            if (contract.estado === 'FINALIZADO') throw new AppError('Un contrato finalizado no puede rescindirse', { statusCode: 409, code: 'CONTRACT_ALREADY_FINALIZED' });

            const effectiveDate = fechaRescision ? parseDateOnly(fechaRescision) : argentinaTodayAsDate();
            if (effectiveDate < contract.fechaInicio) {
                throw new AppError('La fecha de rescisión no puede ser anterior al inicio del contrato', { statusCode: 400, code: 'INVALID_RESCISSION_DATE' });
            }
            if (effectiveDate > argentinaTodayAsDate()) {
                throw new AppError('La fecha de rescisión no puede ser futura', { statusCode: 400, code: 'INVALID_RESCISSION_DATE' });
            }
            await assertContractCanBeRescinded(tx, contract.id);

            const claim = await tx.contrato.updateMany({
                where: { id: contract.id, inmobiliariaId, version },
                data: {
                    estado: 'RESCINDIDO',
                    fechaRescision: effectiveDate,
                    motivoRescision: motivo,
                    rescindidoPorId: usuarioId,
                    actualizadoPorId: usuarioId,
                    eliminadoEn: null,
                    estadoAnteriorPapelera: null,
                    version: { increment: 1 }
                }
            });
            const currentVersion = claim.count === 0
                ? (await tx.contrato.findFirst({ where: { id: contract.id, inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(claim.count, version, currentVersion);
            await syncPropertyOccupancy(tx, [contract.propiedadId]);
            return tx.contrato.findUniqueOrThrow({ where: { id: contract.id } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

        await auditService.log({
            usuarioId,
            inmobiliariaId,
            accion: 'RESCINDIR_CONTRATO',
            entidad: 'Contrato',
            entidadId: contractId,
            severidad: 'WARNING',
            detalle: compactChanges({ motivo: { anterior: null, nuevo: motivo }, fechaRescision: { anterior: null, nuevo: updated.fechaRescision } })
        });
        res.json({ message: 'Contrato rescindido correctamente', version: updated.version, fechaRescision: updated.fechaRescision });
    } catch (error) {
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        res.status(500).json({ message: 'No se pudo rescindir el contrato' });
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

        const previousState = contract.estadoAnteriorPapelera && contract.estadoAnteriorPapelera !== 'PAPELERA'
            ? contract.estadoAnteriorPapelera
            : null;
        const restoredState = previousState === 'FINALIZADO' || previousState === 'RESCINDIDO'
            ? previousState
            : getContractStateForDates(contract.fechaInicio, contract.fechaFin);

        await prisma.$transaction(async tx => {
            if (restoredState === 'ACTIVO' || restoredState === 'PROGRAMADO') {
                await assertPropertyAvailableForPeriod(tx, contract.propiedadId, contract.fechaInicio, contract.fechaFin, contract.id);
            }
            await tx.contrato.update({
                where: { id: Number(id) },
                data: {
                    estado: restoredState,
                    estadoAnteriorPapelera: null,
                    eliminadoEn: null,
                    actualizadoPorId: (req as AuthRequest).user!.id,
                    version: { increment: 1 }
                }
            });
            await syncPropertyOccupancy(tx, [contract.propiedadId]);
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
        modalidadCobroInquilino,
        modalidadPagoPropietario,
        cuentaCobroAcordadaId,
        porcentajeActualizacion,
        tipoAjuste,
        administrado,
        requiereActualizacion,
        moneda,
        serviciosGastos,
        observacionDocumento,
        version
    } = req.body;

    const uploadedFilePath = await commitUploadedFile(req.file, inmobiliariaId);

    try {
        const contract = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId },
            include: { serviciosGastos: { orderBy: { orden: 'asc' } } }
        });

        if (!contract) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        if (contract.version !== version) {
            assertOptimisticUpdate(0, version, contract.version);
        }

        if (contract.estado === 'PAPELERA') {
            return res.status(409).json({ message: 'Restaurá el contrato antes de editarlo' });
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
        if (serviciosGastos !== undefined) {
            changes.serviciosGastos = { anterior: contract.serviciosGastos, nuevo: serviciosGastos };
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
            updateData.porcentajeHonorarios = new Decimal(porcentajeHonorarios);
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
        if (modalidadCobroInquilino !== undefined) {
            updateData.modalidadCobroInquilino = modalidadCobroInquilino || null;
            changes.modalidadCobroInquilino = { anterior: contract.modalidadCobroInquilino, nuevo: updateData.modalidadCobroInquilino };
        }
        if (cuentaCobroAcordadaId !== undefined || (modalidadCobroInquilino !== undefined && modalidadCobroInquilino !== 'TRANSFERENCIA')) {
            updateData.cuentaCobroAcordadaId = (modalidadCobroInquilino ?? contract.modalidadCobroInquilino) === 'TRANSFERENCIA' ? cuentaCobroAcordadaId || null : null;
            changes.cuentaCobroAcordadaId = { anterior: contract.cuentaCobroAcordadaId, nuevo: updateData.cuentaCobroAcordadaId };
        }
        if (modalidadPagoPropietario !== undefined) {
            updateData.modalidadPagoPropietario = modalidadPagoPropietario || null;
            changes.modalidadPagoPropietario = { anterior: contract.modalidadPagoPropietario, nuevo: updateData.modalidadPagoPropietario };
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

        const nextStartDate = updateData.fechaInicio || contract.fechaInicio;
        const nextEndDate = updateData.fechaFin || contract.fechaFin;
        if (nextStartDate > nextEndDate) {
            throw new AppError('La fecha de fin debe ser posterior o igual a la fecha de inicio', {
                statusCode: 400,
                code: 'INVALID_CONTRACT_DATES'
            });
        }

        if (contract.estado === 'ACTIVO' || contract.estado === 'PROGRAMADO') {
            updateData.estado = getContractStateForDates(nextStartDate, nextEndDate);
            if (updateData.estado !== contract.estado) {
                changes.estado = { anterior: contract.estado, nuevo: updateData.estado };
            }
        }

        const rentChanged = updateData.montoAlquiler !== undefined
            && !new Decimal(updateData.montoAlquiler).equals(contract.montoAlquiler);

        const updated = await prisma.$transaction(async tx => {
            const agreedMethod = updateData.modalidadCobroInquilino !== undefined ? updateData.modalidadCobroInquilino : contract.modalidadCobroInquilino;
            const agreedAccountId = updateData.cuentaCobroAcordadaId !== undefined ? updateData.cuentaCobroAcordadaId : contract.cuentaCobroAcordadaId;
            if (agreedMethod === 'TRANSFERENCIA' && !agreedAccountId) throw new AppError('Seleccioná la cuenta acordada para cobrar las transferencias del inquilino', { statusCode: 400, code: 'AGREED_COLLECTION_ACCOUNT_REQUIRED' });
            await assertAgreedCollectionAccount(tx, agreedAccountId, inmobiliariaId, updateData.moneda || contract.moneda);
            if (updateData.estado === 'ACTIVO' || updateData.estado === 'PROGRAMADO') {
                await assertPropertyAvailableForPeriod(tx, contract.propiedadId, nextStartDate, nextEndDate, contract.id);
            }
            const claim = await tx.contrato.updateMany({
                where: { id: Number(id), inmobiliariaId, version },
                data: { ...updateData, version: { increment: 1 } }
            });
            const currentVersion = claim.count === 0
                ? (await tx.contrato.findFirst({ where: { id: Number(id), inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(claim.count, version, currentVersion);
            if (rentChanged) {
                await tx.actualizacionContrato.create({
                    data: {
                        contratoId: contract.id,
                        montoAnterior: contract.montoAlquiler,
                        montoNuevo: updateData.montoAlquiler,
                        moneda: contract.moneda,
                        fechaProximaAnterior: contract.fechaProximaActualizacion,
                        fechaProximaNueva: updateData.fechaProximaActualizacion
                            || contract.fechaProximaActualizacion
                            || argentinaTodayAsDate(),
                        observaciones: 'Cambio de alquiler registrado desde la edición del contrato',
                        usuarioId: (req as AuthRequest).user!.id
                    }
                });
            }
            if (uploadedFilePath) {
                await createPrincipalContractDocument(tx, {
                    contratoId: contract.id,
                    rutaArchivo: uploadedFilePath,
                    nombreArchivo: req.file?.originalname,
                    observacion: observacionDocumento,
                    creadoPorId: (req as AuthRequest).user!.id
                });
            }
            if (serviciosGastos !== undefined) {
                await tx.servicioGastoContrato.deleteMany({ where: { contratoId: contract.id } });
                if (serviciosGastos.length) {
                    await tx.servicioGastoContrato.createMany({
                        data: serviciosGastos.map((servicioGasto: { concepto: string; responsable: 'INQUILINO' | 'PROPIETARIO' }, index: number) => ({
                            contratoId: contract.id,
                            concepto: servicioGasto.concepto,
                            responsable: servicioGasto.responsable,
                            orden: index
                        }))
                    });
                }
            }
            const result = await tx.contrato.findUniqueOrThrow({
                where: { id: Number(id) },
                include: {
                    propiedad: true,
                    inquilinos: { include: { persona: true } },
                    propietarios: { include: { persona: true } },
                    serviciosGastos: { orderBy: { orden: 'asc' } },
                    adjuntos: {
                        include: { creadoPor: { select: { id: true, nombreCompleto: true } } },
                        orderBy: [{ tipo: 'asc' }, { versionDocumento: 'desc' }, { id: 'desc' }]
                    }
                }
            });
            await syncPropertyOccupancy(tx, [contract.propiedadId]);
            return result;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        
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
        if (uploadedFilePath) await removeUploadedFile(uploadedFilePath);
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        console.error(error);
        res.status(500).json({ message: 'Error al actualizar contrato' });
    }
});

// Actualizar monto de alquiler con registro de historia
router.post('/:id/actualizar', requirePermission('contratos.editar'), validateBody(contractRentUpdateSchema), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { id } = req.params;
    const { montoNuevo, fechaProximaNueva, observaciones, version } = req.body;

    try {
        const contrato = await prisma.contrato.findFirst({
            where: { id: Number(id), inmobiliariaId }
        });

        if (!contrato) {
            return res.status(404).json({ message: 'Contrato no encontrado' });
        }

        if (contrato.version !== version) {
            assertOptimisticUpdate(0, version, contrato.version);
        }

        if (!contrato.requiereActualizacion) {
            return res.status(400).json({ message: 'Este contrato no tiene actualización de alquiler programada.' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const claim = await tx.contrato.updateMany({
                where: { id: Number(id), inmobiliariaId, version },
                data: {
                    montoAlquiler: new Decimal(montoNuevo),
                    fechaProximaActualizacion: parseDateOnly(fechaProximaNueva),
                    actualizadoPorId: (req as AuthRequest).user!.id,
                    version: { increment: 1 }
                }
            });
            const currentVersion = claim.count === 0
                ? (await tx.contrato.findFirst({ where: { id: Number(id), inmobiliariaId }, select: { version: true } }))?.version
                : undefined;
            assertOptimisticUpdate(claim.count, version, currentVersion);

            // Registrar la historia sólo después de reservar la versión del contrato.
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

            const actualizado = await tx.contrato.findUniqueOrThrow({
                where: { id: Number(id) },
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
        if (error instanceof AppError) {
            return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
        }
        console.error('Error al actualizar monto de contrato:', error);
        res.status(500).json({ message: 'Error al actualizar contrato' });
    }
});

export default router;

