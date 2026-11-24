import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { AuthRequest, requireRecentAuthentication } from '../middlewares/auth.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { dateOnlyString, positiveMoney, requiredText, optionalText, validateBody } from '../middlewares/validation.middleware';
import { financialOperation, financialError } from '../services/financial-operation.service';
import { registerRentPrepayment, cancelRentPrepayment } from '../services/rent-prepayment.service';
import { collectFromOwner, reverseOwnerCollection } from '../services/owner-collection.service';
import { invalidatePerformanceCache } from '../services/performance-cache.service';
const router = Router();
const advanceSchema = z.object({
    periodoDesde: dateOnlyString('El período').refine(value => value.endsWith('-01'), 'El período debe comenzar el día 01'),
    meses: z.coerce.number().int().min(1).max(60), montoMensual: positiveMoney('El importe mensual cubierto'), moneda: z.enum(['ARS', 'USD']),
    fechaPago: dateOnlyString('La fecha del pago'), observaciones: requiredText('La referencia o aclaración del anticipo', 1000),
    recibidoPorPropietario: z.literal(true)
}).strict();
const reasonSchema = z.object({ motivo: requiredText('El motivo', 1000).min(5) }).strict();
const collectionSchema = z.object({
    monto: positiveMoney('El importe cobrado'), moneda: z.enum(['ARS', 'USD']), fechaPago: dateOnlyString('La fecha del cobro'),
    metodoPago: z.enum(['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE']), cuentaBancariaId: z.coerce.number().int().positive().optional(),
    comprobante: optionalText(120), observaciones: optionalText(1000)
}).strict();
for (const parameter of ['id', 'anticipoId', 'cobroId']) router.param(parameter, (req, res, next, id) => Number.isSafeInteger(Number(id)) && Number(id) > 0 ? next() : res.status(400).json({ message: 'Identificador inválido' }));
router.param('contratoId', (req, res, next, id) => Number.isSafeInteger(Number(id)) && Number(id) > 0 ? next() : res.status(400).json({ message: 'Contrato inválido' }));
router.get('/contrato/:contratoId/anticipos', requirePermission('liquidaciones.ver'), async (req, res, next) => {
    try {
        const inmobiliariaId = (req as AuthRequest).user!.inmobiliariaId;
        const contratoId = Number(req.params.contratoId);
        if (!await prisma.contrato.findFirst({ where: { id: contratoId, inmobiliariaId } })) return res.status(404).json({ message: 'Contrato no encontrado' });
        res.json(await prisma.anticipoAlquiler.findMany({ where: { contratoId, inmobiliariaId }, orderBy: { periodoDesde: 'desc' } }));
    } catch (error) { next(error); }
});
router.post('/contrato/:contratoId/anticipos', requirePermission('liquidaciones.editar'), requirePermission('pagos.crear'), validateBody(advanceSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    try {
        const result = await financialOperation(req as AuthRequest, tx => registerRentPrepayment(tx, { inmobiliariaId, usuarioId, contratoId: Number(req.params.contratoId) }, req.body));
        invalidatePerformanceCache(inmobiliariaId); res.status(201).json(result);
    } catch (error) { const e = financialError(error); res.status(e.statusCode).json({ message: e.message, code: e.code }); }
});
router.post('/anticipos/:anticipoId/anular', requirePermission('liquidaciones.editar'), requirePermission('pagos.eliminar'), requireRecentAuthentication, validateBody(reasonSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    try {
        const id = z.coerce.number().int().positive().parse(req.params.anticipoId);
        const result = await financialOperation(req as AuthRequest, tx => cancelRentPrepayment(tx, { inmobiliariaId, usuarioId }, id, req.body.motivo));
        invalidatePerformanceCache(inmobiliariaId); res.json(result);
    } catch (error) { const e = financialError(error); res.status(e.statusCode).json({ message: e.message, code: e.code }); }
});
router.post('/:id/cobros-propietario', requirePermission('pagos.crear'), validateBody(collectionSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    try {
        const liquidacionId = z.coerce.number().int().positive().parse(req.params.id);
        const result = await financialOperation(req as AuthRequest, tx => collectFromOwner(tx, { inmobiliariaId, usuarioId, liquidacionId }, req.body));
        invalidatePerformanceCache(inmobiliariaId); res.status(201).json(result);
    } catch (error) { const e = financialError(error); res.status(e.statusCode).json({ message: e.message, code: e.code }); }
});
router.post('/:id/cobros-propietario/:cobroId/anular', requirePermission('pagos.eliminar'), requireRecentAuthentication, validateBody(reasonSchema), async (req, res) => {
    const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
    try {
        const liquidacionId = z.coerce.number().int().positive().parse(req.params.id);
        const id = z.coerce.number().int().positive().parse(req.params.cobroId);
        const result = await financialOperation(req as AuthRequest, tx => reverseOwnerCollection(tx, { inmobiliariaId, usuarioId, liquidacionId }, id, req.body.motivo));
        invalidatePerformanceCache(inmobiliariaId); res.json(result);
    } catch (error) { const e = financialError(error); res.status(e.statusCode).json({ message: e.message, code: e.code }); }
});
export default router;
