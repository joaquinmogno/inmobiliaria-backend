import { Router } from 'express';
import { prisma } from '../prisma';
import { authenticateToken, AuthRequest } from '../middlewares/auth.middleware';
import { requireAdmin, requirePermission } from '../middlewares/permissions.middleware';
import { validateBody, requiredText } from '../middlewares/validation.middleware';
import { z } from 'zod';
import { auditService } from '../services/audit.service';

const router = Router();

const accountSchema = z.object({
  nombre: requiredText('El nombre', 100),
  banco: requiredText('El banco', 100),
  moneda: z.enum(['ARS', 'USD']),
  activa: z.boolean().optional().default(true)
});

// Las pantallas financieras necesitan las cuentas activas; su administración
// queda reservada al administrador de la inmobiliaria.
router.get('/', authenticateToken, requirePermission('caja_chica.ver'), async (req: AuthRequest, res) => {
  const { inmobiliariaId } = req.user!;
  const includeInactive = req.query.incluirInactivas === 'true';
  const cuentas = await prisma.cuentaBancaria.findMany({
    where: { inmobiliariaId, ...(includeInactive ? {} : { activa: true }) },
    orderBy: [{ activa: 'desc' }, { banco: 'asc' }, { nombre: 'asc' }]
  });
  res.json(cuentas);
});

router.post('/', authenticateToken, requireAdmin, validateBody(accountSchema), async (req: AuthRequest, res) => {
  const { inmobiliariaId, id: usuarioId } = req.user!;
  try {
    const cuenta = await prisma.cuentaBancaria.create({ data: { ...req.body, inmobiliariaId } });
    await auditService.log({ usuarioId, inmobiliariaId, accion: 'CREAR_CUENTA_BANCARIA', entidad: 'CuentaBancaria', entidadId: cuenta.id, detalle: `${cuenta.banco} · ${cuenta.nombre} · ${cuenta.moneda}` });
    res.status(201).json(cuenta);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ message: 'Ya existe una cuenta con ese nombre.', code: 'BANK_ACCOUNT_DUPLICATE' });
    throw error;
  }
});

router.put('/:id', authenticateToken, requireAdmin, validateBody(accountSchema), async (req: AuthRequest, res) => {
  const { inmobiliariaId, id: usuarioId } = req.user!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ message: 'Cuenta bancaria inválida.' });
  const existing = await prisma.cuentaBancaria.findFirst({ where: { id, inmobiliariaId } });
  if (!existing) return res.status(404).json({ message: 'Cuenta bancaria no encontrada.' });
  if (existing.esHistorica) return res.status(409).json({ message: 'La cuenta histórica no puede editarse.' });
  if (existing.moneda !== req.body.moneda) {
    const movimientos = await prisma.movimientoCaja.count({ where: { cuentaBancariaId: id } });
    if (movimientos > 0) {
      return res.status(409).json({
        message: 'No se puede cambiar la moneda de una cuenta con movimientos. Desactivala y creá una cuenta nueva para conservar la conciliación histórica.',
        code: 'BANK_ACCOUNT_CURRENCY_HAS_MOVEMENTS'
      });
    }
  }
  try {
    const cuenta = await prisma.cuentaBancaria.update({ where: { id }, data: req.body });
    await auditService.log({ usuarioId, inmobiliariaId, accion: 'ACTUALIZAR_CUENTA_BANCARIA', entidad: 'CuentaBancaria', entidadId: cuenta.id, detalle: `${cuenta.banco} · ${cuenta.nombre} · ${cuenta.activa ? 'activa' : 'inactiva'}` });
    res.json(cuenta);
  } catch (error: any) {
    if (error.code === 'P2002') return res.status(409).json({ message: 'Ya existe una cuenta con ese nombre.', code: 'BANK_ACCOUNT_DUPLICATE' });
    throw error;
  }
});

export default router;
