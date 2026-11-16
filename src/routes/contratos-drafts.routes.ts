import { Router } from 'express';
import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import path from 'path';
import { TipoDocumentoContrato } from '@prisma/client';
import { prisma } from '../prisma';
import { AuthRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { cleanupFailedUpload, commitUploadedFile, removeUploadedFile, upload, validateUploadedFileContent } from '../middlewares/upload.middleware';
import { validateBody } from '../middlewares/validation.middleware';
import {
    contractDraftAttachmentSchema,
    contractDraftUpdateSchema,
    contractDraftWriteSchema
} from '../validation/borradores-contrato.schemas';
import { auditService } from '../services/audit.service';
import { draftScope, lockContractDraft } from '../services/contract-draft.service';
import { AppError } from '../errors/app-error';

const router = Router();

const draftInclude = {
    adjuntos: { orderBy: [{ tipo: 'asc' as const }, { id: 'asc' as const }] },
    creadoPor: { select: { id: true, nombreCompleto: true } }
};

const fileHash = async (filePath: string) => {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(filePath)) hash.update(chunk);
    return hash.digest('hex');
};
const uploadRoot = process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads');

const draftSummary = (datos: unknown) => {
    const data = datos as { form?: { address?: string }; selectedProperty?: { direccion?: string } | null; owners?: Array<{ nombreCompleto?: string }>; tenants?: Array<{ nombreCompleto?: string }> };
    return {
        direccion: data.selectedProperty?.direccion || data.form?.address || 'Contrato sin dirección',
        propietario: data.owners?.find(owner => owner.nombreCompleto?.trim())?.nombreCompleto?.trim() || null,
        inquilino: data.tenants?.find(tenant => tenant.nombreCompleto?.trim())?.nombreCompleto?.trim() || null
    };
};

const withSummary = <T extends { datos: unknown }>(draft: T) => ({ ...draft, resumen: draftSummary(draft.datos) });

router.get('/', requirePermission('contratos.crear'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    try {
        const drafts = await prisma.borradorContrato.findMany({
            where: draftScope(user),
            include: draftInclude,
            orderBy: [{ fechaActualizacion: 'desc' }, { id: 'desc' }],
            take: 100
        });
        res.json(drafts.map(withSummary));
    } catch (error) {
        console.error('Error fetching contract drafts:', error);
        res.status(500).json({ message: 'No se pudieron obtener los borradores' });
    }
});

router.get('/:id', requirePermission('contratos.crear'), async (req, res, next) => {
    const user = (req as AuthRequest).user!;
    const id = Number(req.params.id);
    try {
        const draft = await prisma.borradorContrato.findFirst({
            where: { id, ...draftScope(user) },
            include: draftInclude
        });
        if (!draft) return res.status(404).json({ message: 'Borrador no encontrado' });
        res.json(withSummary(draft));
    } catch (error) { next(error); }
});

router.post('/', requirePermission('contratos.crear'), validateBody(contractDraftWriteSchema), async (req, res) => {
    const user = (req as AuthRequest).user!;
    try {
        const draft = await prisma.borradorContrato.create({
            data: {
                datos: req.body.datos,
                inmobiliariaId: user.inmobiliariaId,
                creadoPorId: user.id,
                actualizadoPorId: user.id
            },
            include: draftInclude
        });
        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'CREAR_BORRADOR_CONTRATO',
            entidad: 'BorradorContrato',
            entidadId: draft.id,
            detalle: `Borrador de contrato guardado: ${draftSummary(draft.datos).direccion}`
        });
        res.status(201).json(withSummary(draft));
    } catch (error) {
        console.error('Error creating contract draft:', error);
        res.status(500).json({ message: 'No se pudo guardar el borrador' });
    }
});

router.put('/:id', requirePermission('contratos.crear'), validateBody(contractDraftUpdateSchema), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const id = Number(req.params.id);
    try {
        const draft = await prisma.$transaction(async tx => {
            const updated = await tx.borradorContrato.updateMany({
                where: { id, ...draftScope(user), version: req.body.version },
                data: { datos: req.body.datos, actualizadoPorId: user.id, version: { increment: 1 } }
            });
            return updated.count ? tx.borradorContrato.findFirstOrThrow({ where: { id, ...draftScope(user) }, include: draftInclude }) : null;
        });
        if (!draft) {
            const exists = await prisma.borradorContrato.findFirst({ where: { id, ...draftScope(user) }, select: { id: true } });
            if (!exists) return res.status(404).json({ message: 'Borrador no encontrado' });
            return res.status(409).json({ message: 'Otra pestaña guardó una versión nueva. Tus cambios siguen en el formulario. Copialos antes de cerrar y volver a continuar el borrador actualizado.', code: 'DRAFT_CHANGED' });
        }
        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'ACTUALIZAR_BORRADOR_CONTRATO',
            entidad: 'BorradorContrato',
            entidadId: id,
            detalle: `Borrador de contrato actualizado: ${draftSummary(draft.datos).direccion}`
        });
        res.json(withSummary(draft));
    } catch (error) {
        console.error('Error updating contract draft:', error);
        res.status(500).json({ message: 'No se pudo actualizar el borrador' });
    }
});

router.post('/:id/adjuntos', requirePermission('contratos.crear'), upload.single('archivo'), validateUploadedFileContent, cleanupFailedUpload, validateBody(contractDraftAttachmentSchema), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const draftId = Number(req.params.id);
    if (!req.file) return res.status(400).json({ message: 'No se subió ningún archivo' });

    const filePath = await commitUploadedFile(req.file, user.inmobiliariaId);
    let persisted = false;
    try {
        const tipo = req.body.tipo as TipoDocumentoContrato;
        const incomingHash = await fileHash(req.file.path);
        const result = await prisma.$transaction(async tx => {
            await lockContractDraft(tx, draftId, user);
            const existing = await tx.adjuntoBorradorContrato.findMany({ where: { borradorId: draftId, tipo } });
            // A response can be lost after commit. Retrying the same file must
            // return its existing attachment, even from another tab.
            for (const item of existing.filter(item => item.nombreArchivo === req.file!.originalname)) {
                if (await fileHash(path.join(uploadRoot, item.rutaArchivo)) === incomingHash) {
                    return { attachment: item, duplicate: true, replaced: [] };
                }
            }
            const replaced = tipo === TipoDocumentoContrato.CONTRATO_PRINCIPAL ? existing : [];
            if (replaced.length) await tx.adjuntoBorradorContrato.deleteMany({ where: { borradorId: draftId, tipo } });
            const attachment = await tx.adjuntoBorradorContrato.create({
                data: { borradorId: draftId, rutaArchivo: filePath!, nombreArchivo: req.file!.originalname, tipo, creadoPorId: user.id }
            });
            await tx.borradorContrato.update({ where: { id: draftId }, data: { fechaActualizacion: new Date() } });
            return { attachment, duplicate: false, replaced };
        });
        const { attachment, replaced, duplicate } = result;
        if (duplicate) {
            await removeUploadedFile(filePath);
            return res.status(200).json(attachment);
        }
        persisted = true;
        // From now on the file belongs to a committed row, even if a later
        // response fails. The generic failed-request cleanup must leave it.
        req.file = undefined;
        await Promise.all(replaced.map(item => removeUploadedFile(item.rutaArchivo)));
        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'AGREGAR_ADJUNTO_BORRADOR_CONTRATO',
            entidad: 'BorradorContrato',
            entidadId: draftId,
            detalle: `Archivo agregado al borrador: ${attachment.nombreArchivo}`
        });
        res.status(201).json(attachment);
    } catch (error) {
        if (!persisted) await removeUploadedFile(filePath);
        if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message, code: error.code });
        console.error('Error uploading contract draft attachment:', error);
        res.status(500).json({ message: 'No se pudo guardar el archivo del borrador' });
    }
});

router.delete('/:id/adjuntos/:adjuntoId', requirePermission('contratos.crear'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const draftId = Number(req.params.id);
    const attachmentId = Number(req.params.adjuntoId);
    try {
        const attachment = await prisma.$transaction(async tx => {
            await lockContractDraft(tx, draftId, user);
            const item = await tx.adjuntoBorradorContrato.findFirst({ where: { id: attachmentId, borradorId: draftId } });
            if (item) {
                await tx.adjuntoBorradorContrato.delete({ where: { id: item.id } });
                await tx.borradorContrato.update({ where: { id: draftId }, data: { fechaActualizacion: new Date() } });
            }
            return item;
        });
        if (!attachment) return res.status(404).json({ message: 'Archivo del borrador no encontrado' });
        await removeUploadedFile(attachment.rutaArchivo);
        res.status(204).send();
    } catch (error) {
        if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message, code: error.code });
        console.error('Error deleting contract draft attachment:', error);
        res.status(500).json({ message: 'No se pudo eliminar el archivo del borrador' });
    }
});

router.delete('/:id', requirePermission('contratos.crear'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const id = Number(req.params.id);
    try {
        const draft = await prisma.$transaction(async tx => {
            await lockContractDraft(tx, id, user);
            const item = await tx.borradorContrato.findFirstOrThrow({
                where: { id, ...draftScope(user) }, include: { adjuntos: { select: { rutaArchivo: true } } }
            });
            await tx.borradorContrato.delete({ where: { id } });
            return item;
        });
        await Promise.all(draft.adjuntos.map(item => removeUploadedFile(item.rutaArchivo)));
        await auditService.log({
            usuarioId: user.id,
            inmobiliariaId: user.inmobiliariaId,
            accion: 'ELIMINAR_BORRADOR_CONTRATO',
            entidad: 'BorradorContrato',
            entidadId: id,
            detalle: `Borrador de contrato eliminado: ${draftSummary(draft.datos).direccion}`
        });
        res.status(204).send();
    } catch (error) {
        if (error instanceof AppError) return res.status(error.statusCode).json({ message: error.message, code: error.code });
        console.error('Error deleting contract draft:', error);
        res.status(500).json({ message: 'No se pudo eliminar el borrador' });
    }
});

export default router;
