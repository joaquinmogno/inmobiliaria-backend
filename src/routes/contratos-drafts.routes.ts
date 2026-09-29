import { Router } from 'express';
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

const router = Router();

const draftInclude = {
    adjuntos: { orderBy: [{ tipo: 'asc' as const }, { id: 'asc' as const }] },
    creadoPor: { select: { id: true, nombreCompleto: true } }
};

const draftScope = (user: NonNullable<AuthRequest['user']>) => ({
    inmobiliariaId: user.inmobiliariaId,
    ...(user.tipo === 'ADMIN' ? {} : { creadoPorId: user.id })
});

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

router.get('/:id', requirePermission('contratos.crear'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const id = Number(req.params.id);
    const draft = await prisma.borradorContrato.findFirst({
        where: { id, ...draftScope(user) },
        include: draftInclude
    });
    if (!draft) return res.status(404).json({ message: 'Borrador no encontrado' });
    res.json(withSummary(draft));
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
        const existing = await prisma.borradorContrato.findFirst({ where: { id, ...draftScope(user) } });
        if (!existing) return res.status(404).json({ message: 'Borrador no encontrado' });
        if (existing.version !== req.body.version) {
            return res.status(409).json({ message: 'El borrador cambió mientras lo estabas editando. Actualizá la pantalla.', code: 'DRAFT_CHANGED' });
        }
        const draft = await prisma.borradorContrato.update({
            where: { id },
            data: { datos: req.body.datos, actualizadoPorId: user.id, version: { increment: 1 } },
            include: draftInclude
        });
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
    try {
        const draft = await prisma.borradorContrato.findFirst({ where: { id: draftId, ...draftScope(user) } });
        if (!draft) {
            await removeUploadedFile(filePath);
            return res.status(404).json({ message: 'Borrador no encontrado' });
        }

        const tipo = req.body.tipo as TipoDocumentoContrato;
        const replaced = tipo === TipoDocumentoContrato.CONTRATO_PRINCIPAL
            ? await prisma.adjuntoBorradorContrato.findMany({ where: { borradorId: draftId, tipo }, select: { rutaArchivo: true } })
            : [];
        const attachment = await prisma.$transaction(async tx => {
            if (replaced.length) await tx.adjuntoBorradorContrato.deleteMany({ where: { borradorId: draftId, tipo } });
            return tx.adjuntoBorradorContrato.create({
                data: { borradorId: draftId, rutaArchivo: filePath!, nombreArchivo: req.file!.originalname, tipo, creadoPorId: user.id }
            });
        });
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
        await removeUploadedFile(filePath);
        console.error('Error uploading contract draft attachment:', error);
        res.status(500).json({ message: 'No se pudo guardar el archivo del borrador' });
    }
});

router.delete('/:id/adjuntos/:adjuntoId', requirePermission('contratos.crear'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const draftId = Number(req.params.id);
    const attachmentId = Number(req.params.adjuntoId);
    try {
        const attachment = await prisma.adjuntoBorradorContrato.findFirst({
            where: { id: attachmentId, borradorId: draftId, borrador: draftScope(user) }
        });
        if (!attachment) return res.status(404).json({ message: 'Archivo del borrador no encontrado' });
        await prisma.adjuntoBorradorContrato.delete({ where: { id: attachmentId } });
        await removeUploadedFile(attachment.rutaArchivo);
        res.status(204).send();
    } catch (error) {
        console.error('Error deleting contract draft attachment:', error);
        res.status(500).json({ message: 'No se pudo eliminar el archivo del borrador' });
    }
});

router.delete('/:id', requirePermission('contratos.crear'), async (req, res) => {
    const user = (req as AuthRequest).user!;
    const id = Number(req.params.id);
    try {
        const draft = await prisma.borradorContrato.findFirst({
            where: { id, ...draftScope(user) },
            include: { adjuntos: { select: { rutaArchivo: true } } }
        });
        if (!draft) return res.status(404).json({ message: 'Borrador no encontrado' });
        await prisma.borradorContrato.delete({ where: { id } });
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
        console.error('Error deleting contract draft:', error);
        res.status(500).json({ message: 'No se pudo eliminar el borrador' });
    }
});

export default router;
