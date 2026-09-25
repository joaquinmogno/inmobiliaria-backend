import { EstadoLiquidacion, Prisma } from '@prisma/client';
import { Router } from 'express';
import { AuthRequest } from '../middlewares/auth.middleware';
import { withPagination } from '../middlewares/pagination.middleware';
import { requirePermission } from '../middlewares/permissions.middleware';
import { prisma } from '../prisma';
import { auditService } from '../services/audit.service';
import { argentinaTodayAsDate, parseDateOnly } from '../utils/argentina-date';
import { getMonthlyLiquidationPreparation } from '../services/liquidation-preparation.service';
import { getVoucherSummary } from '../services/liquidation-voucher.service';
import { buildOwnerPaymentHistory } from '../services/owner-payment-history.service';
import { getAgencyAdvanceExposure, getOwnerPaymentSettlement, getTenantSettlement } from '../services/tenant-credit.service';
import { getOutstandingOwnerAdvances } from '../services/owner-advance.service';

const router = Router();

router.get('/', requirePermission('liquidaciones.ver'), withPagination(50), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const { contratoId, search, estado, estadoCobro, estadoPagoPropietario, periodo, propietarioId, inquilinoId, propiedadId, moneda, soloDeuda, vencidas, pendientePropietario, adelantos } = req.query;
    const { page, limit, skip } = res.locals.pagination;
    if (estado && !Object.values(EstadoLiquidacion).includes(String(estado) as EstadoLiquidacion)) {
        return res.status(400).json({ message: 'Estado de liquidación inválido' });
    }
    if (moneda && !['ARS', 'USD'].includes(String(moneda))) {
        return res.status(400).json({ message: 'Moneda inválida' });
    }
    if (estadoCobro && !['PENDIENTE', 'PARCIAL', 'COBRADO', 'NO_APLICA'].includes(String(estadoCobro))) return res.status(400).json({ message: 'Estado de cobro inválido' });
    if (estadoPagoPropietario && !['PENDIENTE', 'PARCIAL', 'PAGADO', 'NO_APLICA'].includes(String(estadoPagoPropietario))) return res.status(400).json({ message: 'Estado de pago al propietario inválido' });
    try {
        const where: any = {
            inmobiliariaId,
            ...(contratoId ? { contratoId: Number(contratoId) } : {}),
            ...(estado ? { estado: String(estado) as EstadoLiquidacion } : {}),
            ...(estadoCobro ? { estadoCobroInquilino: String(estadoCobro) } : {}),
            ...(estadoPagoPropietario ? { estadoPagoPropietario: String(estadoPagoPropietario) } : {}),
            ...(periodo ? { periodo: parseDateOnly(String(periodo).slice(0, 10)) } : {}),
            ...(moneda ? { moneda: String(moneda) } : {}),
            ...(propiedadId ? { contrato: { propiedadId: Number(propiedadId) } } : {}),
            ...(vencidas === 'true' ? { estado: 'CONFIRMADA', estadoCobroInquilino: { in: ['PENDIENTE', 'PARCIAL'] }, fechaVencimiento: { lt: argentinaTodayAsDate() } } : {}),
            ...(pendientePropietario === 'true' ? { estado: 'CONFIRMADA', estadoPagoPropietario: { in: ['PENDIENTE', 'PARCIAL'] } } : {})
        };
        const contractFilters: any[] = [];
        if (search) contractFilters.push({ OR: [
            { propiedad: { direccion: { contains: String(search), mode: 'insensitive' } } },
            { inquilinos: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } },
            { propietarios: { some: { persona: { nombreCompleto: { contains: String(search), mode: 'insensitive' } } } } }
        ] });
        if (propietarioId) contractFilters.push({ propietarios: { some: { personaId: Number(propietarioId) } } });
        if (inquilinoId) contractFilters.push({ inquilinos: { some: { personaId: Number(inquilinoId) } } });
        if (contractFilters.length) {
            where.contrato = where.contrato ? { AND: [where.contrato, ...contractFilters] } : { AND: contractFilters };
        }

        if (adelantos === 'true') {
            const advanceIds = (await getOutstandingOwnerAdvances(prisma, inmobiliariaId)).map(item => item.liquidacionId);
            where.id = { in: advanceIds };
        }

        if (soloDeuda === 'true') {
            const debtRows = await prisma.$queryRaw<{ id: number }[]>(Prisma.sql`
                SELECT l.id
                FROM "Liquidacion" l
                WHERE l."inmobiliariaId" = ${inmobiliariaId}
                  AND l."netoACobrar" >
                    COALESCE((SELECT SUM(p.monto) FROM "Pago" p WHERE p."liquidacionId" = l.id AND p."anuladoEn" IS NULL), 0)
                    + COALESCE((SELECT SUM(ac.monto) FROM "AplicacionCreditoInquilino" ac WHERE ac."liquidacionId" = l.id), 0)
            `);
            const debtIds = debtRows.map(row => row.id);
            where.id = where.id ? { in: where.id.in.filter((id: number) => debtIds.includes(id)) } : { in: debtIds };
        }

        const [total, liquidaciones] = await prisma.$transaction([
            prisma.liquidacion.count({ where }),
            prisma.liquidacion.findMany({
                where,
                include: {
                    contrato: {
                        include: {
                            propiedad: true,
                            inquilinos: { where: { esPrincipal: true }, include: { persona: true } },
                            propietarios: { where: { esPrincipal: true }, include: { persona: true } }
                        }
                    },
                    pagos: { where: { anuladoEn: null } },
                    aplicacionesCredito: true,
                    pagosPropietario: { where: { anuladoEn: null }, select: { monto: true } }
                },
                orderBy: [{ periodo: 'desc' }, { id: 'desc' }],
                skip,
                take: limit
            })
        ]);
        // El listado también necesita el resumen financiero, no sólo el detalle.
        // Se reconstruye desde los movimientos vigentes para que el saldo mostrado
        // sea el mismo que se usa al registrar una entrega o un adelanto.
        const data = liquidaciones.map(liquidacion => {
            const tenantSettlement = getTenantSettlement(liquidacion);
            const ownerSettlement = getOwnerPaymentSettlement(liquidacion);
            return {
                ...liquidacion,
                montoPagadoPropietario: ownerSettlement.pagado.toNumber(),
                resumenOperativo: {
                    cobradoInquilino: tenantSettlement.pagos.toNumber(),
                    creditoAplicadoInquilino: tenantSettlement.creditosAplicados.toNumber(),
                    saldoInquilino: tenantSettlement.saldo.toNumber(),
                    pagadoPropietario: ownerSettlement.pagado.toNumber(),
                    saldoPropietario: ownerSettlement.saldo.toNumber(),
                    capitalPropioExpuesto: getAgencyAdvanceExposure(liquidacion).toNumber()
                }
            };
        });
        res.json({ data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
    } catch (error) {
        console.error('Error fetching liquidaciones:', error);
        res.status(500).json({ message: 'Error al obtener liquidaciones' });
    }
});

router.get('/preparacion', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const periodo = String(req.query.periodo || '');
    if (!/^\d{4}-(0[1-9]|1[0-2])-01$/.test(periodo)) {
        return res.status(400).json({ message: 'El período debe tener formato YYYY-MM-01', code: 'INVALID_LIQUIDATION_PERIOD' });
    }
    try {
        const preparation = await getMonthlyLiquidationPreparation(inmobiliariaId, parseDateOnly(periodo));
        await auditService.log({
            usuarioId: (req as AuthRequest).user!.id,
            inmobiliariaId,
            accion: 'PREPARAR_LIQUIDACIONES_PERIODO',
            entidad: 'Liquidacion',
            detalle: JSON.stringify({ periodo, resumen: preparation.resumen })
        });
        res.json(preparation);
    } catch (error) {
        console.error('Error preparing monthly liquidations:', error);
        res.status(500).json({ message: 'No se pudo preparar el período' });
    }
});

router.get('/filtros', requirePermission('liquidaciones.ver'), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const periodRows = await prisma.liquidacion.groupBy({
        by: ['periodo'], where: { inmobiliariaId }, orderBy: { periodo: 'desc' }
    });
    // Las personas e inmuebles no se descargan completos: se buscan de forma
    // remota y paginada desde los endpoints siguientes.
    res.json({
        periodos: periodRows.map(row => row.periodo),
        monedas: ['ARS', 'USD']
    });
});

router.get('/filtros/personas', requirePermission('liquidaciones.ver'), withPagination(25), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const role = String(req.query.rol || '');
    const search = String(req.query.search || '').trim();
    const requestedId = Number(req.query.id);
    if (role !== 'PROPIETARIO' && role !== 'INQUILINO') {
        return res.status(400).json({ message: 'Rol de persona inválido' });
    }

    const relation = role === 'PROPIETARIO' ? 'contratosPropietario' : 'contratosInquilino';
    const where: any = {
        inmobiliariaId,
        [relation]: { some: { contrato: { inmobiliariaId, liquidaciones: { some: {} } } } },
        ...(Number.isInteger(requestedId) && requestedId > 0 ? { id: requestedId } : {}),
        ...(search ? { OR: [
            { nombreCompleto: { contains: search, mode: 'insensitive' } },
            { dni: { contains: search, mode: 'insensitive' } },
            { cuit: { contains: search, mode: 'insensitive' } }
        ] } : {})
    };
    const { page, limit, skip } = res.locals.pagination;
    const [total, data] = await prisma.$transaction([
        prisma.persona.count({ where }),
        prisma.persona.findMany({
            where,
            select: { id: true, nombreCompleto: true },
            orderBy: [{ nombreCompleto: 'asc' }, { id: 'asc' }],
            skip,
            take: limit
        })
    ]);
    res.json({ data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

router.get('/filtros/propiedades', requirePermission('liquidaciones.ver'), withPagination(25), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const search = String(req.query.search || '').trim();
    const requestedId = Number(req.query.id);
    const where: any = {
        inmobiliariaId,
        contratos: { some: { liquidaciones: { some: {} } } },
        ...(Number.isInteger(requestedId) && requestedId > 0 ? { id: requestedId } : {}),
        ...(search ? { OR: [
            { direccion: { contains: search, mode: 'insensitive' } },
            { partidaInmobiliaria: { contains: search.toUpperCase(), mode: 'insensitive' } },
            { matricula: { contains: search.toUpperCase(), mode: 'insensitive' } }
        ] } : {})
    };
    const { page, limit, skip } = res.locals.pagination;
    const [total, data] = await prisma.$transaction([
        prisma.propiedad.count({ where }),
        prisma.propiedad.findMany({
            where,
            select: { id: true, direccion: true, piso: true, departamento: true },
            orderBy: [{ direccion: 'asc' }, { id: 'asc' }],
            skip,
            take: limit
        })
    ]);
    res.json({ data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } });
});

router.get('/:id', requirePermission('liquidaciones.ver'), withPagination(10, {
    pageParam: 'auditPage', limitParam: 'auditLimit', localsKey: 'auditPagination'
}), async (req, res) => {
    const { inmobiliariaId } = (req as AuthRequest).user!;
    const liquidationId = Number(req.params.id);
    try {
        const liquidacion = await prisma.liquidacion.findFirst({
            where: { id: liquidationId, inmobiliariaId },
            include: {
                movimientos: true,
                contrato: {
                    include: {
                        propiedad: true,
                        inquilinos: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
                        propietarios: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } }
                    }
                },
                pagos: { where: { anuladoEn: null }, include: { creadoPor: { select: { id: true, nombreCompleto: true, email: true } } } },
                ajustes: {
                    include: {
                        creadoPor: { select: { id: true, nombreCompleto: true } },
                        creditoInquilino: {
                            include: {
                                aplicaciones: {
                                    include: { liquidacion: { select: { id: true, periodo: true } } },
                                    orderBy: { fechaAplicacion: 'desc' }
                                },
                                movimientoDevolucion: { select: { id: true, fecha: true, metodoPago: true } }
                            }
                        }
                    },
                    orderBy: { fechaCreacion: 'desc' }
                },
                aplicacionesCredito: {
                    include: {
                        creditoInquilino: {
                            include: { ajusteLiquidacion: { select: { id: true, concepto: true } } }
                        }
                    },
                    orderBy: { fechaAplicacion: 'desc' }
                },
                pagosPropietario: {
                    include: {
                        propietario: { select: { id: true, nombreCompleto: true } },
                        creadoPor: { select: { id: true, nombreCompleto: true } },
                        anuladoPor: { select: { id: true, nombreCompleto: true } },
                        movimientoCaja: { select: { id: true, reversion: { select: { id: true, fecha: true, fechaCreacion: true } } } }
                    },
                    orderBy: [{ fechaCreacion: 'asc' }, { id: 'asc' }]
                },
                propietarioPago: { select: { id: true, nombreCompleto: true } },
                pagoPropietarioMovimiento: {
                    select: { id: true, monto: true, fecha: true, metodoPago: true, cuenta: true, anuladoEn: true }
                },
                comprobantes: {
                    select: {
                        id: true,
                        version: true,
                        fechaEmision: true,
                        fotografia: true,
                        creadoPor: { select: { id: true, nombreCompleto: true } }
                    },
                    orderBy: { version: 'desc' }
                },
                creadoPor: { select: { id: true, nombreCompleto: true, email: true } },
                confirmadoPor: { select: { id: true, nombreCompleto: true, email: true } },
                cerradoPor: { select: { id: true, nombreCompleto: true, email: true } }
            }
        });
        if (!liquidacion) return res.status(404).json({ message: 'Liquidación no encontrada' });
        const auditLogs = await auditService.history({
            inmobiliariaId, entidad: 'Liquidacion', entidadId: liquidationId, ...res.locals.auditPagination
        });
        const { comprobantes, pagosPropietario, ...detalleLiquidacion } = liquidacion;
        const tenantSettlement = getTenantSettlement(liquidacion);
        const ownerSettlement = getOwnerPaymentSettlement({ montoPropietario: liquidacion.montoPropietario, pagosPropietario: pagosPropietario.filter(payment => !payment.anuladoEn) });
        res.json({
            ...detalleLiquidacion,
            montoPagadoPropietario: ownerSettlement.pagado.toNumber(),
            comprobantes: comprobantes.map(getVoucherSummary),
            historialPagosPropietario: buildOwnerPaymentHistory(liquidacion.montoPropietario, pagosPropietario),
            resumenOperativo: {
                cobradoInquilino: tenantSettlement.pagos.toNumber(),
                creditoAplicadoInquilino: tenantSettlement.creditosAplicados.toNumber(),
                saldoInquilino: tenantSettlement.saldo.toNumber(),
                pagadoPropietario: ownerSettlement.pagado.toNumber(),
                saldoPropietario: ownerSettlement.saldo.toNumber(),
                capitalPropioExpuesto: getAgencyAdvanceExposure({ pagos: liquidacion.pagos, pagosPropietario: pagosPropietario.filter(payment => !payment.anuladoEn) }).toNumber()
            },
            auditLogs: auditLogs.data,
            auditMeta: auditLogs.meta
        });
    } catch {
        res.status(500).json({ message: 'Error al obtener detalle de liquidación' });
    }
});

export default router;
