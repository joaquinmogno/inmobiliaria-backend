import { Router, type Request, type Response, type NextFunction } from 'express';
import path from 'path';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { authenticateToken, type AuthRequest } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { validateBody, idParamSchema } from '../middlewares/validation.middleware';
import { cleanupFailedUpload, commitUploadedFile, removeUploadedFile, upload, validateUploadedFilesContent } from '../middlewares/upload.middleware';
import { auditService } from '../services/audit.service';
import { AppError } from '../errors/app-error';
import { parseDateOnly } from '../utils/argentina-date';
import { parsePagination } from '../utils/pagination';
import { anularMovimientoInternoSchema, adjuntarMovimientoInternoSchema, editarMovimientoInternoSchema, filtroControlInternoSchema, movimientoInternoSchema } from '../validation/control-interno.schemas';
import { internalMovementInclude, internalMovementWhere, summarizeInternalMovements } from '../services/control-interno.service';
import { buildInternalExcel, buildInternalPdf } from '../services/control-interno-report.service';

const router = Router();
const uploadsRoot = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '../../uploads'));
const reportLimit = 20000;
router.use(authenticateToken, requirePermission('control_interno.ver'));

const auth = (req: Request) => (req as AuthRequest).user!;
const idOf = (value: unknown) => {
    const parsed = idParamSchema.safeParse(value);
    if (!parsed.success) throw new AppError('Identificador inválido', { statusCode: 400 });
    return parsed.data;
};
const filtersOf = (req: Request) => {
    const parsed = filtroControlInternoSchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(parsed.error.issues.map(issue => issue.message).join('. '), { statusCode: 400, code: 'INVALID_INTERNAL_FILTERS' });
    return parsed.data;
};
const claimError = () => new AppError('El registro cambió o fue anulado. Actualizá la planilla antes de continuar.', { statusCode: 409, code: 'INTERNAL_MOVEMENT_CHANGED' });
const ensureRecord = async (req: Request) => {
    const record = await prisma.movimientoInterno.findFirst({ where: { id: idOf(req.params.id), inmobiliariaId: auth(req).inmobiliariaId } });
    if (!record) throw new AppError('Movimiento no encontrado', { statusCode: 404 });
    return record;
};

const receiveFiles = (req: Request, res: Response, next: NextFunction) => {
    upload.array('comprobantes', 10)(req, res, error => {
        if (error) return next(new AppError(error.code === 'LIMIT_FILE_SIZE' ? 'El comprobante supera los 30 MB' : 'No se pudieron cargar los comprobantes. Usá hasta 10 archivos PDF, JPG, PNG o WEBP.', { statusCode: 400, code: 'INVALID_INTERNAL_UPLOAD' }));
        const files = (req.files || []) as Express.Multer.File[];
        if (files.some(file => !['.pdf', '.jpg', '.jpeg', '.png', '.webp'].includes(path.extname(file.originalname).toLowerCase()))) {
            return next(new AppError('Los comprobantes deben ser PDF, JPG, PNG o WEBP', { statusCode: 400, code: 'INVALID_INTERNAL_UPLOAD' }));
        }
        next();
    });
};
const attachmentData = async (req: Request, moved: string[]) => {
    const result = [];
    for (const file of (req.files || []) as Express.Multer.File[]) {
        const rutaArchivo = await commitUploadedFile(file, auth(req).inmobiliariaId);
        if (!rutaArchivo) continue;
        moved.push(rutaArchivo);
        result.push({ rutaArchivo, nombreArchivo: path.basename(file.originalname).replace(/[\x00-\x1F]/g, '').slice(0, 255) || 'Comprobante', tipoContenido: file.mimetype, tamano: file.size, creadoPorId: auth(req).id });
    }
    return result;
};
const auditWrite = (req: Request, accion: string, entidadId: number, detalle: string) => auditService.log({
    usuarioId: auth(req).id, inmobiliariaId: auth(req).inmobiliariaId, accion, entidad: 'MovimientoInterno', entidadId, detalle
});

router.get('/', async (req, res) => {
    const filters = filtersOf(req);
    const where = internalMovementWhere(auth(req).inmobiliariaId, filters);
    const { page, limit, skip } = parsePagination(req.query.page, req.query.limit);
    const result = await prisma.$transaction(async tx => {
        const [data, total, amounts] = await Promise.all([
            tx.movimientoInterno.findMany({ where, include: internalMovementInclude, orderBy: [{ fecha: 'desc' }, { id: 'desc' }], skip, take: limit }),
            tx.movimientoInterno.count({ where }),
            tx.movimientoInterno.groupBy({ by: ['moneda', 'tipo'], where: { ...where, anuladoEn: null, ...(filters.estado === 'ANULADOS' ? { id: -1 } : {}) }, _sum: { monto: true } })
        ]);
        return { data, total, amounts };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    res.json({ data: result.data, meta: { page, limit, total: result.total, totalPages: Math.ceil(result.total / limit) }, resumen: summarizeInternalMovements(result.amounts.map(row => ({ ...row, monto: row._sum.monto || 0 }))), periodo: filters.periodo });
});

router.get('/opciones', async (req, res) => {
    const inmobiliariaId = auth(req).inmobiliariaId;
    const [categories, methods, authors] = await Promise.all([
        prisma.movimientoInterno.findMany({ where: { inmobiliariaId, categoria: { not: null } }, select: { categoria: true }, distinct: ['categoria'], orderBy: { categoria: 'asc' } }),
        prisma.movimientoInterno.findMany({ where: { inmobiliariaId, metodoPago: { not: null } }, select: { metodoPago: true }, distinct: ['metodoPago'], orderBy: { metodoPago: 'asc' } }),
        prisma.movimientoInterno.findMany({ where: { inmobiliariaId }, select: { creadoPor: { select: { id: true, nombreCompleto: true } } }, distinct: ['creadoPorId'] })
    ]);
    res.json({ categorias: categories.map(row => row.categoria).filter(Boolean), mediosPago: methods.map(row => row.metodoPago).filter(Boolean), usuarios: authors.map(row => row.creadoPor) });
});

for (const format of ['excel', 'pdf'] as const) {
    router.get(`/reportes/${format}`, requirePermission('control_interno.reportes'), async (req, res) => {
        const filters = filtersOf(req);
        const where = internalMovementWhere(auth(req).inmobiliariaId, filters);
        const rows = await prisma.movimientoInterno.findMany({ where, include: internalMovementInclude, orderBy: [{ fecha: 'asc' }, { id: 'asc' }], take: reportLimit + 1 });
        if (rows.length > reportLimit) throw new AppError('La selección supera los 20.000 registros. Acotá los filtros para generar el reporte.', { statusCode: 422, code: 'INTERNAL_REPORT_TOO_LARGE' });
        const agency = await prisma.inmobiliaria.findUniqueOrThrow({ where: { id: auth(req).inmobiliariaId }, select: { nombre: true } });
        const report = { rows, filters, agency: agency.nombre };
        const buffer = format === 'excel' ? await buildInternalExcel(report) : await buildInternalPdf(report);
        res.setHeader('Content-Type', format === 'excel' ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="control-interno-${filters.periodo}.${format === 'excel' ? 'xlsx' : 'pdf'}"`);
        await auditService.log({ usuarioId: auth(req).id, inmobiliariaId: auth(req).inmobiliariaId, accion: 'EXPORTAR_CONTROL_INTERNO', entidad: 'ControlInterno', detalle: JSON.stringify({ formato: format, filtros: filters, registros: rows.length }) });
        res.send(buffer);
    });
}

router.get('/adjuntos/:id/archivo', async (req, res, next) => {
    const attachment = await prisma.adjuntoMovimientoInterno.findFirst({
        where: { id: idOf(req.params.id), movimientoInterno: { inmobiliariaId: auth(req).inmobiliariaId } },
        include: { movimientoInterno: { select: { id: true } } }
    });
    if (!attachment) throw new AppError('Comprobante no encontrado', { statusCode: 404 });
    const agencyRoot = path.join(uploadsRoot, `inmobiliaria-${auth(req).inmobiliariaId}`);
    const filename = path.resolve(uploadsRoot, attachment.rutaArchivo);
    if (!filename.startsWith(`${agencyRoot}${path.sep}`)) throw new AppError('Comprobante no encontrado', { statusCode: 404 });
    res.setHeader('Content-Type', attachment.tipoContenido);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `${req.query.descargar === '1' ? 'attachment' : 'inline'}; filename="comprobante-${attachment.id}${path.extname(filename)}"; filename*=UTF-8''${encodeURIComponent(attachment.nombreArchivo)}`);
    res.sendFile(filename, error => {
        if (error) { if (!res.headersSent) res.status(404).json({ message: 'Comprobante no disponible' }); else next(error); return; }
        void auditWrite(req, 'CONSULTAR_COMPROBANTE_INTERNO', attachment.movimientoInternoId, attachment.nombreArchivo);
    });
});

router.post('/', requirePermission('control_interno.crear'), cleanupFailedUpload, receiveFiles, validateUploadedFilesContent, validateBody(movimientoInternoSchema), async (req, res) => {
    const moved: string[] = [];
    try {
        const files = await attachmentData(req, moved);
        const { fecha, monto, categoria, metodoPago, observaciones, ...rest } = req.body;
        const record = await prisma.movimientoInterno.create({
            data: { ...rest, fecha: parseDateOnly(fecha), monto: new Prisma.Decimal(monto), categoria: categoria || null, metodoPago: metodoPago || null, observaciones: observaciones || null, inmobiliariaId: auth(req).inmobiliariaId, creadoPorId: auth(req).id, adjuntos: { create: files } },
            include: internalMovementInclude
        });
        await auditWrite(req, 'CREAR_MOVIMIENTO_INTERNO', record.id, JSON.stringify({ tipo: record.tipo, detalle: record.detalle, monto: record.monto, moneda: record.moneda }));
        res.status(201).json(record);
    } catch (error) { await Promise.all(moved.map(removeUploadedFile)); throw error; }
});

router.put('/:id', requirePermission('control_interno.editar'), validateBody(editarMovimientoInternoSchema), async (req, res) => {
    const original = await ensureRecord(req);
    const { version, fecha, monto, categoria, metodoPago, observaciones, ...rest } = req.body;
    const updated = await prisma.$transaction(async tx => {
        const claimed = await tx.movimientoInterno.updateMany({
            where: { id: original.id, inmobiliariaId: auth(req).inmobiliariaId, version, anuladoEn: null },
            data: { ...rest, fecha: parseDateOnly(fecha), monto: new Prisma.Decimal(monto), categoria: categoria || null, metodoPago: metodoPago || null, observaciones: observaciones || null, actualizadoPorId: auth(req).id, version: { increment: 1 } }
        });
        if (claimed.count !== 1) throw claimError();
        return tx.movimientoInterno.findUniqueOrThrow({ where: { id: original.id }, include: internalMovementInclude });
    });
    await auditWrite(req, 'EDITAR_MOVIMIENTO_INTERNO', original.id, JSON.stringify({ anterior: original, nuevo: { ...req.body, version: updated.version } }));
    res.json(updated);
});

router.post('/:id/adjuntos', requirePermission('control_interno.editar'), cleanupFailedUpload, receiveFiles, validateUploadedFilesContent, validateBody(adjuntarMovimientoInternoSchema), async (req, res) => {
    const original = await ensureRecord(req);
    const moved: string[] = [];
    try {
        if (!(req.files as Express.Multer.File[])?.length) throw new AppError('Seleccioná al menos un comprobante', { statusCode: 400 });
        const files = await attachmentData(req, moved);
        const updated = await prisma.$transaction(async tx => {
            const claimed = await tx.movimientoInterno.updateMany({ where: { id: original.id, inmobiliariaId: auth(req).inmobiliariaId, version: req.body.version, anuladoEn: null }, data: { version: { increment: 1 }, actualizadoPorId: auth(req).id } });
            if (claimed.count !== 1) throw claimError();
            await tx.adjuntoMovimientoInterno.createMany({ data: files.map(file => ({ ...file, movimientoInternoId: original.id })) });
            return tx.movimientoInterno.findUniqueOrThrow({ where: { id: original.id }, include: internalMovementInclude });
        });
        await auditWrite(req, 'ADJUNTAR_COMPROBANTE_INTERNO', original.id, files.map(file => file.nombreArchivo).join(', '));
        res.status(201).json(updated);
    } catch (error) { await Promise.all(moved.map(removeUploadedFile)); throw error; }
});

router.post('/:id/anular', requirePermission('control_interno.anular'), validateBody(anularMovimientoInternoSchema), async (req, res) => {
    const original = await ensureRecord(req);
    const updated = await prisma.$transaction(async tx => {
        const claimed = await tx.movimientoInterno.updateMany({
            where: { id: original.id, inmobiliariaId: auth(req).inmobiliariaId, version: req.body.version, anuladoEn: null },
            data: { anuladoEn: new Date(), anuladoPorId: auth(req).id, motivoAnulacion: req.body.motivo, version: { increment: 1 } }
        });
        if (claimed.count !== 1) throw claimError();
        return tx.movimientoInterno.findUniqueOrThrow({ where: { id: original.id }, include: internalMovementInclude });
    });
    await auditWrite(req, 'ANULAR_MOVIMIENTO_INTERNO', original.id, req.body.motivo);
    res.json(updated);
});

export default router;
