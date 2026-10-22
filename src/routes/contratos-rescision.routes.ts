import { Router, type Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { userHasPermission } from '../services/permissions.service';
import { validateBody } from '../middlewares/validation.middleware';
import { cleanupFailedUpload, commitUploadedFile, removeUploadedFile, upload, validateUploadedFileContent } from '../middlewares/upload.middleware';
import { contractRescissionRevisionSchema, contractRescissionSchema, keyDeliverySchema, type ContractRescissionInput, type KeyDeliveryInput } from '../validation/contratos.schemas';
import { getRescissionContext, buildKeyDeliverySnapshot, keyDeliveryPreviewHash, buildRescissionSnapshot, rescissionPreviewHash, type KeyDeliverySnapshot, type RescissionSnapshot } from '../services/contract-rescission.service';
import { rescissionActWording, sendKeyDeliveryPdf, sendRescissionPdf } from '../services/contract-rescission-pdf.service';
import { syncPropertyOccupancy } from '../services/contract-lifecycle.service';
import { argentinaTodayAsDate, parseDateOnly } from '../utils/argentina-date';
import { assertOptimisticUpdate } from '../utils/optimistic-lock';
import { auditService } from '../services/audit.service';
import { AppError } from '../errors/app-error';
import { hasContractOutstandingObligations } from '../services/contract-financial-integrity.service';

const router = Router();
const idOf = (value: string | string[]) => Number(Array.isArray(value) ? value[0] : value);

function checkDates(input: ContractRescissionInput, start: string) {
    const effective = parseDateOnly(input.fechaRescision);
    if (effective < parseDateOnly(start) || effective > argentinaTodayAsDate()) {
        throw new AppError('La fecha de rescisión debe estar entre el inicio del contrato y hoy', { statusCode: 400, code: 'INVALID_RESCISSION_DATE' });
    }
    if (input.llavesEntregadas && input.fechaEntregaLlaves) {
        const delivered = parseDateOnly(input.fechaEntregaLlaves);
        if (delivered < parseDateOnly(start) || delivered > argentinaTodayAsDate()) {
            throw new AppError('La entrega de llaves debe ser desde el inicio del contrato hasta hoy', { statusCode: 400, code: 'INVALID_KEY_DELIVERY_DATE' });
        }
    }
}

function handleError(res: Response, error: unknown) {
    if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message, code: error.code, details: error.details });
    if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) return res.status(409).json({ message: 'El acta cambió mientras se guardaba. Volvé a cargarla.', code: 'STALE_WRITE' });
    return res.status(500).json({ message: 'No se pudo procesar el acta de rescisión' });
}

router.get('/:id/rescision/preparacion', requirePermission('contratos.ver'), requirePermission('liquidaciones.ver'), async (req, res) => {
    try {
        const auth = (req as AuthRequest).user!;
        const context = await prisma.$transaction(tx => getRescissionContext(tx, idOf(req.params.id), auth.inmobiliariaId));
        const canViewFiles = await userHasPermission(auth.id, auth.tipo, 'contratos.archivos.ver');
        res.json({ ...context, copiasFirmadas: canViewFiles ? context.copiasFirmadas : [], copiasLlavesFirmadas: canViewFiles ? context.copiasLlavesFirmadas : [] });
    }
    catch (error) { handleError(res, error); }
});

function checkKeyDate(input: KeyDeliveryInput, start: string) {
    const delivered = parseDateOnly(input.fechaEntregaLlaves);
    if (delivered < parseDateOnly(start) || delivered > argentinaTodayAsDate()) {
        throw new AppError('La fecha de entrega debe estar entre el inicio del contrato y hoy', { statusCode: 400, code: 'INVALID_KEY_DELIVERY_DATE' });
    }
}

router.post('/:id/llaves/vista-previa', requirePermission('contratos.ver'), requirePermission('liquidaciones.ver'), validateBody(keyDeliverySchema), async (req, res) => {
    try {
        const context = await prisma.$transaction(tx => getRescissionContext(tx, idOf(req.params.id), (req as AuthRequest).user!.inmobiliariaId));
        if (context.contrato.version !== req.body.version) assertOptimisticUpdate(0, req.body.version, context.contrato.version);
        if (context.contrato.fechaEntregaLlaves) throw new AppError('La entrega de llaves ya fue registrada', { statusCode: 409, code: 'KEYS_ALREADY_DELIVERED' });
        checkKeyDate(req.body, context.contrato.fechaInicio);
        const snapshot = buildKeyDeliverySnapshot(context, req.body);
        res.json({ snapshot, vistaPreviaHash: keyDeliveryPreviewHash(snapshot) });
    } catch (error) { handleError(res, error); }
});

router.post('/:id/llaves', requirePermission('contratos.editar'), requirePermission('liquidaciones.ver'), requireRecentAuthentication, validateBody(keyDeliverySchema), async (req, res) => {
    const { id: userId, inmobiliariaId } = (req as AuthRequest).user!;
    const contractId = idOf(req.params.id);
    const input = req.body as KeyDeliveryInput;
    try {
        const result = await prisma.$transaction(async tx => {
            const context = await getRescissionContext(tx, contractId, inmobiliariaId);
            const contract = context.contrato;
            if (contract.version !== input.version) assertOptimisticUpdate(0, input.version, contract.version);
            if (contract.fechaEntregaLlaves || context.actasLlaves.length) throw new AppError('La entrega de llaves ya fue registrada', { statusCode: 409, code: 'KEYS_ALREADY_DELIVERED' });
            if (!['ACTIVO', 'FINALIZADO'].includes(contract.estado)) throw new AppError('El contrato no permite registrar una entrega de llaves', { statusCode: 409, code: 'INVALID_CONTRACT_STATE' });
            checkKeyDate(input, contract.fechaInicio);
            const snapshot = buildKeyDeliverySnapshot(context, input);
            if (!input.vistaPreviaHash || input.vistaPreviaHash !== keyDeliveryPreviewHash(snapshot)) throw new AppError('Los datos cambiaron desde la vista previa. Revisalos nuevamente.', { statusCode: 409, code: 'KEY_DELIVERY_PREVIEW_STALE' });
            const claim = await tx.contrato.updateMany({
                where: { id: contractId, inmobiliariaId, version: input.version, fechaEntregaLlaves: null },
                data: {
                    fechaEntregaLlaves: parseDateOnly(input.fechaEntregaLlaves),
                    fechaRescision: parseDateOnly(input.fechaEntregaLlaves),
                    estado: 'EN_CIERRE',
                    actualizadoPorId: userId, version: { increment: 1 }
                }
            });
            assertOptimisticUpdate(claim.count, input.version);
            const acta = await tx.actaEntregaLlaves.create({ data: {
                contratoId: contractId, inmobiliariaId, version: 1,
                datos: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
                creadoPorId: userId
            } });
            const updated = await tx.contrato.findUniqueOrThrow({ where: { id: contractId }, select: { propiedadId: true } });
            await syncPropertyOccupancy(tx, [updated.propiedadId]);
            return { acta, contratoVersion: input.version + 1 };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        await auditService.log({ usuarioId: userId, inmobiliariaId, accion: 'REGISTRAR_ENTREGA_LLAVES', entidad: 'Contrato', entidadId: contractId, severidad: 'WARNING', detalle: `Acta de llaves v${result.acta.version}; fecha ${input.fechaEntregaLlaves}` });
        res.status(201).json({ actaVersion: result.acta.version, contratoVersion: result.contratoVersion, pdf: `/contratos/${contractId}/actas-llaves/1/pdf` });
    } catch (error) { handleError(res, error); }
});

router.get('/:id/actas-llaves/:version/pdf', requirePermission('contratos.archivos.ver'), requirePermission('liquidaciones.ver'), async (req, res) => {
    try {
        const acta = await prisma.actaEntregaLlaves.findFirst({ where: { contratoId: idOf(req.params.id), version: idOf(req.params.version), inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId } });
        if (!acta) throw new AppError('Acta de llaves no encontrada', { statusCode: 404, code: 'KEY_DELIVERY_ACT_NOT_FOUND' });
        sendKeyDeliveryPdf(res, acta.datos as unknown as KeyDeliverySnapshot, acta.version, acta.fechaEmision);
    } catch (error) { handleError(res, error); }
});

router.post('/:id/actas-llaves/:version/copia-firmada', requirePermission('contratos.editar'), upload.single('archivo'), validateUploadedFileContent, cleanupFailedUpload, async (req, res) => {
    const { id: userId, inmobiliariaId } = (req as AuthRequest).user!;
    const contractId = idOf(req.params.id);
    const version = idOf(req.params.version);
    if (!req.file) return res.status(400).json({ message: 'Seleccioná una copia firmada' });
    const acta = await prisma.actaEntregaLlaves.findFirst({ where: { contratoId: contractId, version, inmobiliariaId } });
    if (!acta) return res.status(404).json({ message: 'Acta de llaves no encontrada' });
    const existing = await prisma.adjuntoContrato.findFirst({ where: { contratoId: contractId, tipo: 'ACTA_LLAVES_FIRMADA', versionDocumento: version } });
    if (existing) return res.status(409).json({ message: 'Esta acta ya tiene una copia firmada' });
    const path = await commitUploadedFile(req.file, inmobiliariaId);
    try {
        const attachment = await prisma.adjuntoContrato.create({ data: {
            contratoId: contractId, tipo: 'ACTA_LLAVES_FIRMADA', versionDocumento: version,
            rutaArchivo: path!, nombreArchivo: req.file.originalname, fechaDocumento: argentinaTodayAsDate(), creadoPorId: userId
        } });
        await auditService.log({ usuarioId: userId, inmobiliariaId, accion: 'ADJUNTAR_ACTA_LLAVES_FIRMADA', entidad: 'Contrato', entidadId: contractId, detalle: `Acta v${version}, adjunto #${attachment.id}` });
        res.status(201).json(attachment);
    } catch (error) { await removeUploadedFile(path); handleError(res, error); }
});

router.post('/:id/rescision/vista-previa', requirePermission('contratos.ver'), requirePermission('liquidaciones.ver'), validateBody(contractRescissionSchema), async (req, res) => {
    try {
        const context = await prisma.$transaction(tx => getRescissionContext(tx, idOf(req.params.id), (req as AuthRequest).user!.inmobiliariaId));
        if (context.contrato.version !== req.body.version) assertOptimisticUpdate(0, req.body.version, context.contrato.version);
        if (!context.contrato.fechaEntregaLlaves || !context.actasLlaves.length) throw new AppError('Primero debe emitirse el acta de entrega de llaves', { statusCode: 409, code: 'KEY_DELIVERY_REQUIRED' });
        const keyDate = context.contrato.fechaEntregaLlaves;
        const keySnapshot = context.actasLlaves[0].datos as unknown as KeyDeliverySnapshot;
        const expectedType = parseDateOnly(keyDate) < parseDateOnly(context.contrato.fechaFin) ? 'ANTICIPADA_INQUILINO' : 'VENCIMIENTO_ACORDADO';
        if (req.body.tipoCierre !== expectedType) throw new AppError('El tipo de cierre no coincide con la fecha de entrega de llaves', { statusCode: 409, code: 'CLOSURE_TYPE_MISMATCH' });
        if (!req.body.llavesEntregadas || req.body.fechaEntregaLlaves !== keyDate || req.body.fechaRescision !== keyDate || req.body.cantidadLlaves !== keySnapshot.entrega.cantidadLlaves || req.body.estadoInmueble !== keySnapshot.entrega.estadoInmueble) throw new AppError('Los datos de entrega deben coincidir con el acta de llaves', { statusCode: 409, code: 'KEY_DELIVERY_IMMUTABLE' });
        if (hasContractOutstandingObligations(context.saldosRegistrados)) throw new AppError('Todavía hay saldos registrados. Resolvelos antes del cierre sin reclamos.', { statusCode: 409, code: 'OUTSTANDING_OBLIGATIONS' });
        const drafts = await prisma.liquidacion.count({ where: { contratoId: context.contrato.id, estado: 'BORRADOR' } });
        if (drafts) throw new AppError('Hay liquidaciones en borrador. Confirmalas o anulalas antes del cierre sin reclamos.', { statusCode: 409, code: 'DRAFT_LIQUIDATIONS_PENDING' });
        checkDates(req.body, context.contrato.fechaInicio);
        const snapshot = buildRescissionSnapshot(context, req.body);
        res.json({ snapshot, wording: rescissionActWording(snapshot), vistaPreviaHash: rescissionPreviewHash(snapshot) });
    } catch (error) { handleError(res, error); }
});

async function issue(req: AuthRequest, res: Response, revision: boolean) {
    const { id: userId, inmobiliariaId } = req.user!;
    const contractId = idOf(req.params.id);
    const input = req.body as ContractRescissionInput & { motivoRevision?: string };
    try {
        const result = await prisma.$transaction(async tx => {
            const context = await getRescissionContext(tx, contractId, inmobiliariaId);
            const contract = context.contrato;
            if (contract.version !== input.version) assertOptimisticUpdate(0, input.version, contract.version);
            if (!['EN_CIERRE', 'RESCINDIDO', 'FINALIZADO'].includes(contract.estado)) throw new AppError('Primero debe registrarse la entrega de llaves', { statusCode: 409, code: 'KEY_DELIVERY_REQUIRED' });
            if (!contract.fechaEntregaLlaves || !context.actasLlaves.length) throw new AppError('Primero debe emitirse el acta de entrega de llaves', { statusCode: 409, code: 'KEY_DELIVERY_REQUIRED' });
            if (!revision && context.actas.length) throw new AppError('El cierre definitivo ya fue emitido', { statusCode: 409, code: 'CLOSURE_ALREADY_ISSUED' });
            if (revision && context.actas.length === 0) throw new AppError('No existe un acta anterior para revisar', { statusCode: 409, code: 'RESCISSION_ACT_MISSING' });
            checkDates(input, contract.fechaInicio);
            const keyDate = contract.fechaEntregaLlaves;
            const originalEnd = parseDateOnly(contract.fechaFin);
            const expectedType = parseDateOnly(keyDate) < originalEnd ? 'ANTICIPADA_INQUILINO' : 'VENCIMIENTO_ACORDADO';
            const keySnapshot = context.actasLlaves[0].datos as unknown as KeyDeliverySnapshot;
            if (input.tipoCierre !== expectedType) throw new AppError('El tipo de cierre no coincide con la fecha de entrega de llaves', { statusCode: 409, code: 'CLOSURE_TYPE_MISMATCH' });
            if (!input.llavesEntregadas || input.fechaEntregaLlaves !== keyDate || input.fechaRescision !== keyDate || input.cantidadLlaves !== keySnapshot.entrega.cantidadLlaves || input.estadoInmueble !== keySnapshot.entrega.estadoInmueble) {
                throw new AppError('Los datos de entrega deben coincidir con el acta de llaves. No se pueden modificar desde el cierre.', { statusCode: 409, code: 'KEY_DELIVERY_IMMUTABLE' });
            }
            if (hasContractOutstandingObligations(context.saldosRegistrados)) throw new AppError('Todavía hay saldos registrados. Resolvelos antes de emitir el cierre sin reclamos.', { statusCode: 409, code: 'OUTSTANDING_OBLIGATIONS' });
            const drafts = await tx.liquidacion.count({ where: { contratoId: contractId, estado: 'BORRADOR' } });
            if (drafts) throw new AppError('Hay liquidaciones en borrador. Confirmalas o anulalas antes del cierre sin reclamos.', { statusCode: 409, code: 'DRAFT_LIQUIDATIONS_PENDING' });
            const claim = await tx.contrato.updateMany({
                where: { id: contractId, inmobiliariaId, version: input.version },
                data: {
                    motivoRescision: input.motivo,
                    ...(!revision && contract.estado === 'EN_CIERRE' ? {
                        estado: input.tipoCierre === 'ANTICIPADA_INQUILINO' ? 'RESCINDIDO' as const : 'FINALIZADO' as const,
                        ...(input.tipoCierre === 'ANTICIPADA_INQUILINO' ? { rescindidoPorId: userId } : {})
                    } : {}),
                    actualizadoPorId: userId, version: { increment: 1 }
                }
            });
            assertOptimisticUpdate(claim.count, input.version);
            const nextVersion = revision ? context.actas[0].version + 1 : 1;
            const snapshot = buildRescissionSnapshot(context, input);
            if (!input.vistaPreviaHash || input.vistaPreviaHash !== rescissionPreviewHash(snapshot)) {
                throw new AppError('Los datos del acta o los saldos cambiaron desde la vista previa. Revisalos nuevamente.', { statusCode: 409, code: 'RESCISSION_PREVIEW_STALE' });
            }
            const acta = await tx.actaRescision.create({ data: {
                contratoId: contractId, inmobiliariaId, version: nextVersion,
                datos: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonValue,
                motivoRevision: revision ? input.motivoRevision : null,
                creadoPorId: userId
            } });
            return { acta, contratoVersion: input.version + 1 };
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        await auditService.log({ usuarioId: userId, inmobiliariaId, accion: revision ? 'REVISAR_ACTA_RESCISION' : 'CERRAR_CONTRATO_SIN_RECLAMOS', entidad: 'Contrato', entidadId: contractId, severidad: 'WARNING', detalle: `Acta v${result.acta.version}${revision ? `: ${input.motivoRevision}` : ''}` });
        res.status(201).json({ actaId: result.acta.id, actaVersion: result.acta.version, contratoVersion: result.contratoVersion, pdf: `/contratos/${contractId}/actas-rescision/${result.acta.version}/pdf` });
    } catch (error) { handleError(res, error); }
}

router.post('/:id/rescindir', requirePermission('contratos.editar'), requirePermission('liquidaciones.ver'), requireRecentAuthentication, validateBody(contractRescissionSchema), (req, res) => issue(req as AuthRequest, res, false));
router.post('/:id/actas-rescision', requirePermission('contratos.editar'), requirePermission('liquidaciones.ver'), requireRecentAuthentication, validateBody(contractRescissionRevisionSchema), (req, res) => issue(req as AuthRequest, res, true));

router.get('/:id/actas-rescision/:version', requirePermission('contratos.ver'), requirePermission('liquidaciones.ver'), async (req, res) => {
    try {
        const acta = await prisma.actaRescision.findFirst({ where: { contratoId: idOf(req.params.id), version: idOf(req.params.version), inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId } });
        if (!acta) throw new AppError('Acta no encontrada', { statusCode: 404, code: 'RESCISSION_ACT_NOT_FOUND' });
        res.json(acta);
    } catch (error) { handleError(res, error); }
});

router.get('/:id/actas-rescision/:version/pdf', requirePermission('contratos.archivos.ver'), requirePermission('liquidaciones.ver'), async (req, res) => {
    try {
        const acta = await prisma.actaRescision.findFirst({ where: { contratoId: idOf(req.params.id), version: idOf(req.params.version), inmobiliariaId: (req as AuthRequest).user!.inmobiliariaId } });
        if (!acta) throw new AppError('Acta no encontrada', { statusCode: 404, code: 'RESCISSION_ACT_NOT_FOUND' });
        sendRescissionPdf(res, acta.datos as unknown as RescissionSnapshot, acta.version, acta.fechaEmision);
    } catch (error) { handleError(res, error); }
});

router.post('/:id/actas-rescision/:version/copia-firmada', requirePermission('contratos.editar'), upload.single('archivo'), validateUploadedFileContent, cleanupFailedUpload, async (req, res) => {
    const { id: userId, inmobiliariaId } = (req as AuthRequest).user!;
    const contractId = idOf(req.params.id);
    const version = idOf(req.params.version);
    if (!req.file) return res.status(400).json({ message: 'Seleccioná una copia firmada' });
    const acta = await prisma.actaRescision.findFirst({ where: { contratoId: contractId, version, inmobiliariaId } });
    if (!acta) return res.status(404).json({ message: 'Acta no encontrada' });
    const existing = await prisma.adjuntoContrato.findFirst({ where: { contratoId: contractId, tipo: 'ACTA_RESCISION_FIRMADA', versionDocumento: version } });
    if (existing) return res.status(409).json({ message: 'Esta versión ya tiene una copia firmada. Emití una nueva versión para conservar la anterior.' });
    const path = await commitUploadedFile(req.file, inmobiliariaId);
    try {
        const attachment = await prisma.adjuntoContrato.create({ data: {
            contratoId: contractId, tipo: 'ACTA_RESCISION_FIRMADA', versionDocumento: version,
            rutaArchivo: path!, nombreArchivo: req.file.originalname, fechaDocumento: argentinaTodayAsDate(), creadoPorId: userId
        } });
        await auditService.log({ usuarioId: userId, inmobiliariaId, accion: 'ADJUNTAR_ACTA_RESCISION_FIRMADA', entidad: 'Contrato', entidadId: contractId, detalle: `Acta v${version}, adjunto #${attachment.id}` });
        res.status(201).json(attachment);
    } catch (error) { await removeUploadedFile(path); handleError(res, error); }
});

export default router;
