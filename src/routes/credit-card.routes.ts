import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../prisma';
import { authenticateToken, type AuthRequest } from '../middlewares/auth.middleware';
import { requireAnyPermission } from '../middlewares/permissions.middleware';
import { validateBody } from '../middlewares/validation.middleware';
import { auditService } from '../services/audit.service';
import { creditCardSchema } from '../services/credit-card.service';
import { AppError } from '../errors/app-error';

const router = Router();
router.use(authenticateToken);
const scopes = {
    CAJA: { view: ['caja_chica.ver', 'liquidaciones.pagar_propietario', 'liquidaciones.ajustar'], write: ['caja_chica.crear', 'liquidaciones.pagar_propietario', 'liquidaciones.ajustar'] },
    INTERNO: { view: ['control_interno.ver'], write: ['control_interno.crear', 'control_interno.editar'] },
    TEODORO: { view: ['teodoro.ver'], write: ['teodoro.crear', 'teodoro.editar'] },
    DANIEL: { view: ['daniel.ver'], write: ['daniel.crear', 'daniel.editar'] }
} as const;
const statusSchema = z.object({ activa: z.boolean(), version: z.number().int().positive() }).strict();

for (const ambito of Object.keys(scopes) as Array<keyof typeof scopes>) {
    const permissions = scopes[ambito];
    router.get(`/${ambito}`, requireAnyPermission(...permissions.view), async (req, res) => {
        const { inmobiliariaId } = (req as AuthRequest).user!;
        res.json(await prisma.tarjetaCredito.findMany({ where: { inmobiliariaId, ambito }, orderBy: [{ activa: 'desc' }, { nombre: 'asc' }, { id: 'asc' }] }));
    });
    router.post(`/${ambito}`, requireAnyPermission(...permissions.write), validateBody(creditCardSchema), async (req, res) => {
        const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
        try {
            const card = await prisma.$transaction(async tx => {
                const created = await tx.tarjetaCredito.create({ data: { ...req.body, inmobiliariaId, ambito } });
                await auditService.log({ inmobiliariaId, usuarioId, accion: 'CREAR_TARJETA', entidad: 'TarjetaCredito', entidadId: created.id, detalle: JSON.stringify({ ambito, ...req.body }) }, tx);
                return created;
            });
            res.status(201).json(card);
        } catch (error: any) {
            if (error.code === 'P2002') throw new AppError('Ya existe una tarjeta con esos datos en este apartado.', { statusCode: 409 });
            throw error;
        }
    });
    // La identidad no se reescribe: si reemplazan una tarjeta, se agrega otra.
    router.patch(`/${ambito}/:id`, requireAnyPermission(...permissions.write), validateBody(statusSchema), async (req, res) => {
        const { inmobiliariaId, id: usuarioId } = (req as AuthRequest).user!;
        const id = Number(req.params.id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new AppError('Tarjeta inválida.', { statusCode: 400 });
        const card = await prisma.$transaction(async tx => {
            const changed = await tx.tarjetaCredito.updateMany({ where: { id, inmobiliariaId, ambito, version: req.body.version }, data: { activa: req.body.activa, version: { increment: 1 } } });
            if (changed.count !== 1) throw new AppError('La tarjeta cambió o no está disponible. Actualizá el listado.', { statusCode: 409 });
            await auditService.log({ inmobiliariaId, usuarioId, accion: req.body.activa ? 'ACTIVAR_TARJETA' : 'DESACTIVAR_TARJETA', entidad: 'TarjetaCredito', entidadId: id, detalle: ambito }, tx);
            return tx.tarjetaCredito.findUniqueOrThrow({ where: { id } });
        });
        res.json(card);
    });
}
export default router;
