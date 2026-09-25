import { EstadoLiquidacion, Moneda, Prisma, TipoMovimiento } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { parseDateOnly } from '../utils/argentina-date';

export const REPORT_CURRENCIES = ['ARS', 'USD'] as const satisfies readonly Moneda[];

export type ReportCurrency = typeof REPORT_CURRENCIES[number];

export type ReportPeriod = {
  inicio: Date;
  finExclusivo: Date;
  etiqueta: string;
};

export const getMonthlyReportPeriod = (year: number, month: number): ReportPeriod => {
  const etiqueta = `${year}-${String(month).padStart(2, '0')}`;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return {
    inicio: parseDateOnly(`${etiqueta}-01`),
    finExclusivo: parseDateOnly(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`),
    etiqueta
  };
};

type CashMovementRow = {
  tipo: TipoMovimiento;
  monto: Prisma.Decimal | Decimal | number | string;
  moneda: Moneda;
  cuenta: 'CAJA' | 'BANCO';
  fecha: Date;
  pagoId: number | null;
  pagoSueldoId: number | null;
  esPagoPropietario: boolean;
  anuladoEn?: Date | null;
  ajustePagoSueldoDe?: { id: number } | null;
  reversionDe?: {
    pagoId: number | null;
    pagoSueldoId: number | null;
    esPagoPropietario: boolean;
    anuladoEn?: Date | null;
  } | null;
};

type CashTotals = {
  ingresos: Decimal;
  egresos: Decimal;
  saldo: Decimal;
  cobrosInquilinos: Decimal;
  pagosPropietarios: Decimal;
  pagosSueldos: Decimal;
  otrosIngresos: Decimal;
  otrosEgresos: Decimal;
  cuentas: Record<'CAJA' | 'BANCO', { ingresos: Decimal; egresos: Decimal; saldo: Decimal }>;
};

const zeroTotals = (): CashTotals => ({
  ingresos: new Decimal(0),
  egresos: new Decimal(0),
  saldo: new Decimal(0),
  cobrosInquilinos: new Decimal(0),
  pagosPropietarios: new Decimal(0),
  pagosSueldos: new Decimal(0),
  otrosIngresos: new Decimal(0),
  otrosEgresos: new Decimal(0),
  cuentas: {
    CAJA: { ingresos: new Decimal(0), egresos: new Decimal(0), saldo: new Decimal(0) },
    BANCO: { ingresos: new Decimal(0), egresos: new Decimal(0), saldo: new Decimal(0) }
  }
});

const serializeCashTotals = (totals: CashTotals) => ({
  ingresos: totals.ingresos.toNumber(),
  egresos: totals.egresos.toNumber(),
  saldo: totals.saldo.toNumber(),
  cobrosInquilinos: totals.cobrosInquilinos.toNumber(),
  pagosPropietarios: totals.pagosPropietarios.toNumber(),
  pagosSueldos: totals.pagosSueldos.toNumber(),
  otrosIngresos: totals.otrosIngresos.toNumber(),
  otrosEgresos: totals.otrosEgresos.toNumber(),
  cuentas: {
    CAJA: Object.fromEntries(Object.entries(totals.cuentas.CAJA).map(([key, value]) => [key, value.toNumber()])),
    BANCO: Object.fromEntries(Object.entries(totals.cuentas.BANCO).map(([key, value]) => [key, value.toNumber()]))
  }
});

const isSalaryMovement = (movement: CashMovementRow) => Boolean(movement.pagoSueldoId || movement.reversionDe?.pagoSueldoId || movement.ajustePagoSueldoDe);

/**
 * Reglas únicas de caja:
 * - un asiento anulado y su reversión forman un único par económico. Si el
 *   original fue anulado (período abierto), se excluyen ambos; de otro modo
 *   la reversión es una corrección real en su fecha;
 * - DESCUENTO no es un flujo de caja.
 */
const isEconomicallyVoided = (movement: CashMovementRow) => Boolean(
  movement.anuladoEn || movement.reversionDe?.anuladoEn
);

const accumulateCashMovement = (totals: CashTotals, movement: CashMovementRow) => {
  if (movement.tipo === TipoMovimiento.DESCUENTO) return;

  const monto = new Decimal(movement.monto.toString());
  const cuenta = totals.cuentas[movement.cuenta];
  const ingreso = movement.tipo === TipoMovimiento.INGRESO;

  if (ingreso) {
    totals.ingresos = totals.ingresos.plus(monto);
    totals.saldo = totals.saldo.plus(monto);
    cuenta.ingresos = cuenta.ingresos.plus(monto);
    cuenta.saldo = cuenta.saldo.plus(monto);
  } else {
    totals.egresos = totals.egresos.plus(monto);
    totals.saldo = totals.saldo.minus(monto);
    cuenta.egresos = cuenta.egresos.plus(monto);
    cuenta.saldo = cuenta.saldo.minus(monto);
  }

  const isTenantPayment = Boolean(movement.pagoId || movement.reversionDe?.pagoId);
  const isOwnerPayment = movement.esPagoPropietario || Boolean(movement.reversionDe?.esPagoPropietario);
  if (isTenantPayment) totals.cobrosInquilinos = totals.cobrosInquilinos.plus(ingreso ? monto : monto.negated());
  else if (isOwnerPayment) totals.pagosPropietarios = totals.pagosPropietarios.plus(ingreso ? monto.negated() : monto);
  else if (isSalaryMovement(movement)) totals.pagosSueldos = totals.pagosSueldos.plus(ingreso ? monto.negated() : monto);
  else if (ingreso) totals.otrosIngresos = totals.otrosIngresos.plus(monto);
  else totals.otrosEgresos = totals.otrosEgresos.plus(monto);
};

const emptyCurrencyMap = () => Object.fromEntries(REPORT_CURRENCIES.map(moneda => [moneda, zeroTotals()])) as Record<ReportCurrency, CashTotals>;

export const calculateCashLedger = (movements: CashMovementRow[], period: ReportPeriod) => {
  const acumulado = emptyCurrencyMap();
  const delPeriodo = emptyCurrencyMap();

  movements.forEach(movement => {
    // Este corte evita que movimientos futuros alteren un saldo usado para
    // cerrar un mes anterior. La anulación se resuelve aquí (y no sólo en la
    // consulta) porque también debe afectar a su asiento de reversión.
    if (movement.fecha >= period.finExclusivo) return;
    if (isEconomicallyVoided(movement)) return;
    accumulateCashMovement(acumulado[movement.moneda], movement);
    if (movement.fecha >= period.inicio) accumulateCashMovement(delPeriodo[movement.moneda], movement);
  });

  return {
    criterio: 'CAJA' as const,
    periodo: period.etiqueta,
    desde: period.inicio.toISOString().slice(0, 10),
    hasta: new Date(period.finExclusivo.getTime() - 86_400_000).toISOString().slice(0, 10),
    saldoAlCierre: Object.fromEntries(REPORT_CURRENCIES.map(moneda => [moneda, serializeCashTotals(acumulado[moneda])])),
    movimientosDelPeriodo: Object.fromEntries(REPORT_CURRENCIES.map(moneda => [moneda, serializeCashTotals(delPeriodo[moneda])]))
  };
};

export async function getCashLedgerReport(
  db: Prisma.TransactionClient | any,
  inmobiliariaId: number,
  period: ReportPeriod
) {
  const movements = await db.movimientoCaja.findMany({
    where: {
      inmobiliariaId,
      fecha: { lt: period.finExclusivo }
    },
    select: {
      tipo: true,
      monto: true,
      moneda: true,
      cuenta: true,
      fecha: true,
      pagoId: true,
      pagoSueldoId: true,
      esPagoPropietario: true,
      anuladoEn: true,
      ajustePagoSueldoDe: { select: { id: true } },
      reversionDe: {
        select: { pagoId: true, pagoSueldoId: true, esPagoPropietario: true, anuladoEn: true }
      }
    }
  });
  return calculateCashLedger(movements, period);
}

type AccruedLiquidationRow = {
  estado: EstadoLiquidacion;
  moneda: Moneda;
  netoACobrar: Prisma.Decimal | Decimal | number | string;
  montoPropietario: Prisma.Decimal | Decimal | number | string;
  pagos?: Array<{ monto: Prisma.Decimal | Decimal | number | string }>;
  aplicacionesCredito?: Array<{ monto: Prisma.Decimal | Decimal | number | string }>;
};

type AccruedTotals = {
  facturado: Decimal;
  honorariosDevengados: Decimal;
  importePropietariosDevengado: Decimal;
  cobradoAplicado: Decimal;
  saldoPendienteInquilinos: Decimal;
};

export const calculateAccruedReport = (liquidations: AccruedLiquidationRow[], period: ReportPeriod) => {
  const totals = Object.fromEntries(REPORT_CURRENCIES.map(moneda => [moneda, {
    facturado: new Decimal(0),
    honorariosDevengados: new Decimal(0),
    importePropietariosDevengado: new Decimal(0),
    cobradoAplicado: new Decimal(0),
    saldoPendienteInquilinos: new Decimal(0)
  }])) as Record<ReportCurrency, AccruedTotals>;

  liquidations.forEach(liquidacion => {
    // El devengado representa documentos emitidos: ni borradores internos ni
    // liquidaciones anuladas pueden modificar facturación, deuda u honorarios.
    if (liquidacion.estado !== EstadoLiquidacion.CONFIRMADA) return;
    const neto = new Decimal(liquidacion.netoACobrar.toString());
    const propietario = new Decimal(liquidacion.montoPropietario.toString());
    totals[liquidacion.moneda].facturado = totals[liquidacion.moneda].facturado.plus(neto);
    totals[liquidacion.moneda].importePropietariosDevengado = totals[liquidacion.moneda].importePropietariosDevengado.plus(propietario);
    totals[liquidacion.moneda].honorariosDevengados = totals[liquidacion.moneda].honorariosDevengados.plus(neto.minus(propietario));
    const aplicado = [...(liquidacion.pagos || []), ...(liquidacion.aplicacionesCredito || [])]
      .reduce((sum, item) => sum.plus(item.monto), new Decimal(0));
    totals[liquidacion.moneda].cobradoAplicado = totals[liquidacion.moneda].cobradoAplicado.plus(Decimal.min(neto, aplicado));
    totals[liquidacion.moneda].saldoPendienteInquilinos = totals[liquidacion.moneda].saldoPendienteInquilinos.plus(Decimal.max(new Decimal(0), neto.minus(aplicado)));
  });

  return {
    criterio: 'DEVENGADO' as const,
    periodo: period.etiqueta,
    desde: period.inicio.toISOString().slice(0, 10),
    hasta: new Date(period.finExclusivo.getTime() - 86_400_000).toISOString().slice(0, 10),
    porMoneda: Object.fromEntries(REPORT_CURRENCIES.map(moneda => [moneda, Object.fromEntries(
      Object.entries(totals[moneda]).map(([key, value]) => [key, value.toNumber()])
    )]))
  };
};

export async function getAccruedFinancialReport(
  db: Prisma.TransactionClient | any,
  inmobiliariaId: number,
  period: ReportPeriod
) {
  const liquidations = await db.liquidacion.findMany({
    where: {
      inmobiliariaId,
      estado: EstadoLiquidacion.CONFIRMADA,
      periodo: { gte: period.inicio, lt: period.finExclusivo }
    },
    select: {
      estado: true,
      moneda: true,
      netoACobrar: true,
      montoPropietario: true,
      pagos: { where: { anuladoEn: null }, select: { monto: true } },
      aplicacionesCredito: { select: { monto: true } }
    }
  });
  return calculateAccruedReport(liquidations, period);
}
