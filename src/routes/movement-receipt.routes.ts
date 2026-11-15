import { Router, type Request } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import type { AuthRequest } from '../middlewares/auth.middleware';
import { requireAnyPermission, requirePermission } from '../middlewares/permissions.middleware';
import { idParamSchema, validateBody } from '../middlewares/validation.middleware';
import type { PermissionKey } from '../services/permissions.service';
import { auditService, getAuditRequestMetadata } from '../services/audit.service';
import { AppError } from '../errors/app-error';
import { assertReceiptIssuable, formatReceiptContext, issueMovementReceipt, loadReceiptSource, makeReceiptSnapshot, receiptConflict, receiptInputSchema, receiptNumber, receiptStatus, type ReceiptInput, type ReceiptScope, type ReceiptSnapshot } from '../services/movement-receipt.service';
import { buildMovementReceiptPdf } from '../services/movement-receipt-pdf.service';

export function createMovementReceiptRouter(scope: ReceiptScope, permissions: { view: PermissionKey; issue: PermissionKey[] }) {
    const router = Router({ mergeParams: true });
    router.use(requirePermission(permissions.view));
    const user = (req: Request) => (req as AuthRequest).user!;
    const id = (value: unknown) => {
        const parsed = idParamSchema.safeParse(value);
        if (!parsed.success) throw new AppError('Identificador inválido', { statusCode: 400 });
        return parsed.data;
    };
    const movementId = (req: Request) => id(req.params.id);
    router.get('/', async (req, res) => {
        const result = await prisma.$transaction(async tx => {
            const source = await loadReceiptSource(tx, scope, movementId(req), user(req).inmobiliariaId);
            const agency = await tx.inmobiliaria.findUniqueOrThrow({ where: { id: user(req).inmobiliariaId }, select: { nombre: true, razonSocial: true } });
            return formatReceiptContext(source, agency.razonSocial || agency.nombre);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
        res.set('Cache-Control', 'private, no-store').json(result);
    });
    router.post('/vista-previa', requireAnyPermission(...permissions.issue), validateBody(receiptInputSchema), async (req, res) => {
        const input = req.body as ReceiptInput;
        const data = await prisma.$transaction(async tx => {
            const source = await loadReceiptSource(tx, scope, movementId(req), user(req).inmobiliariaId);
            assertReceiptIssuable(source, input);
            if (input.ultimaVersion !== (source.recibo?.versiones[0]?.version || 0)) throw receiptConflict();
            return makeReceiptSnapshot(tx, user(req).inmobiliariaId, source, input);
        }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
        const pdf = await buildMovementReceiptPdf(data, { numero: 'SIN EMITIR', version: input.ultimaVersion + 1, fechaEmision: new Date(), estado: 'BORRADOR' });
        // JSON keeps preview on the authenticated API client (CSRF, expired sessions and permission handling).
        res.set('Cache-Control', 'private, no-store').json({ pdf: pdf.toString('base64') });
    });
    router.post('/', requireAnyPermission(...permissions.issue), validateBody(receiptInputSchema), async (req, res) => {
        try {
            const result = await prisma.$transaction(tx => issueMovementReceipt(tx, scope, movementId(req), user(req), req.body as ReceiptInput, getAuditRequestMetadata(req)), { timeout: 15000 });
            res.status(result.creada ? 201 : 200).json(result);
        } catch (error) {
            if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) throw receiptConflict();
            throw error;
        }
    });
    router.get('/:version/pdf', async (req, res) => {
        const version = id(req.params.version);
        const source = await prisma.$transaction(tx => loadReceiptSource(tx, scope, movementId(req), user(req).inmobiliariaId), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
        const row = source.recibo?.versiones.find(item => item.version === version);
        if (!row || !source.recibo) throw new AppError('Recibo no encontrado', { statusCode: 404 });
        const numero = receiptNumber(source.recibo.id);
        const estado = receiptStatus(source.anulado, row.version, source.recibo.versiones[0].version, row.huellaMovimiento, source.huellaMovimiento);
        const pdf = await buildMovementReceiptPdf(row.fotografia as unknown as ReceiptSnapshot, { numero, version, fechaEmision: row.fechaEmision, estado });
        await auditService.log({ usuarioId: user(req).id, inmobiliariaId: user(req).inmobiliariaId, accion: 'DESCARGAR_RECIBO_MOVIMIENTO', entidad: 'ReciboMovimiento', entidadId: source.recibo.id, detalle: JSON.stringify({ numero, version, estado, ambito: scope }), ...getAuditRequestMetadata(req) });
        res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="${numero}-v${version}.pdf"`, 'Cache-Control': 'private, no-store' }).send(pdf);
    });
    return router;
}
