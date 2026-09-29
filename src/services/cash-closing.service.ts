import { CuentaCaja, Moneda, Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';

export const monthStart = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

export type CashPeriodInput = {
  inmobiliariaId: number;
  fecha: Date;
  cuenta: CuentaCaja;
  moneda: Moneda;
  /** Obligatoria para banco en operaciones nuevas; nula para Caja. */
  cuentaBancariaId?: number | null;
};

export type CashMovementPeriod = Pick<CashPeriodInput, 'fecha' | 'cuenta' | 'moneda' | 'cuentaBancariaId'>;

type CashClosingSnapshot = {
  inmobiliariaId: number;
  periodo: Date;
  cuenta: CuentaCaja;
  moneda: Moneda;
  cuentaBancariaId?: number | null;
  saldoSistema: unknown;
  saldoDeclarado: unknown;
  diferencia: unknown;
  motivoDiferencia?: string | null;
  usuarioId: number;
};

const closingScope = (input: Pick<CashPeriodInput, 'inmobiliariaId' | 'fecha' | 'cuenta' | 'moneda' | 'cuentaBancariaId'>) => ({
  inmobiliariaId: input.inmobiliariaId,
  periodo: monthStart(input.fecha),
  cuenta: input.cuenta,
  moneda: input.moneda,
  cuentaBancariaId: input.cuenta === CuentaCaja.BANCO ? input.cuentaBancariaId || null : null
});

const closingScopeForPeriod = (input: Pick<CashClosingSnapshot, 'inmobiliariaId' | 'periodo' | 'cuenta' | 'moneda' | 'cuentaBancariaId'>) => ({
  inmobiliariaId: input.inmobiliariaId,
  periodo: input.periodo,
  cuenta: input.cuenta,
  moneda: input.moneda,
  cuentaBancariaId: input.cuenta === CuentaCaja.BANCO ? input.cuentaBancariaId || null : null
});

// `findFirst` permite distinguir Caja (sin cuenta) de cada cuenta bancaria.
// El fallback sólo sostiene adaptadores/test doubles de versiones anteriores
// mientras se despliega la migración que elimina la clave genérica.
const findClosing = async (db: Prisma.TransactionClient | any, where: Record<string, unknown>) => {
  if (typeof db.cierreCaja.findFirst === 'function') return db.cierreCaja.findFirst({ where });
  return db.cierreCaja.findUnique({
    where: {
      inmobiliariaId_periodo_cuenta_moneda: {
        inmobiliariaId: where.inmobiliariaId,
        periodo: where.periodo,
        cuenta: where.cuenta,
        moneda: where.moneda
      }
    }
  });
};

/**
 * Cierra un período sin reescribir una conciliación ya cerrada.
 *
 * Una reapertura autorizada deja el registro en REABIERTO. Recién entonces se
 * admite un nuevo cierre, que incrementa la versión y agrega otro evento. La
 * bitácora no depende del AuditLog, que es transversal y no es el historial de
 * conciliaciones del período.
 */
export async function closeCashPeriod(db: Prisma.TransactionClient | any, input: CashClosingSnapshot) {
  const scope = closingScopeForPeriod(input);
  const existing = await findClosing(db, scope);

  if (existing?.estado === 'CERRADO') {
    throw new AppError('El período de caja ya está cerrado. Reabrilo con autorización antes de volver a cerrarlo.', {
      statusCode: 409,
      code: 'CASH_PERIOD_ALREADY_CLOSED',
      details: { cierreId: existing.id, version: existing.version }
    });
  }

  let cierre: any;
  let transition: 'CREADO' | 'RECERRADO';
  if (!existing) {
    cierre = await db.cierreCaja.create({
      data: {
        inmobiliariaId: input.inmobiliariaId,
        periodo: input.periodo,
        cuenta: input.cuenta,
        moneda: input.moneda,
        cuentaBancariaId: scope.cuentaBancariaId,
        saldoSistema: input.saldoSistema,
        saldoDeclarado: input.saldoDeclarado,
        diferencia: input.diferencia,
        motivoDiferencia: input.motivoDiferencia || null,
        cerradoPorId: input.usuarioId,
        version: 1
      }
    });
    transition = 'CREADO';
  } else {
    const claimed = await db.cierreCaja.updateMany({
      where: { id: existing.id, estado: 'REABIERTO', version: existing.version },
      data: {
        estado: 'CERRADO',
        saldoSistema: input.saldoSistema,
        saldoDeclarado: input.saldoDeclarado,
        diferencia: input.diferencia,
        motivoDiferencia: input.motivoDiferencia || null,
        cerradoPorId: input.usuarioId,
        cerradoEn: new Date(),
        version: { increment: 1 }
      }
    });
    if (claimed.count !== 1) {
      throw new AppError('El estado del cierre cambió mientras se procesaba la operación. Actualizá la pantalla e intentá nuevamente.', {
        statusCode: 409,
        code: 'CASH_CLOSING_CHANGED'
      });
    }
    cierre = await db.cierreCaja.findUniqueOrThrow({ where: { id: existing.id } });
    transition = 'RECERRADO';
  }

  await db.eventoCierreCaja.create({
    data: {
      cierreCajaId: cierre.id,
      tipo: 'CIERRE',
      version: cierre.version,
      saldoSistema: cierre.saldoSistema,
      saldoDeclarado: cierre.saldoDeclarado,
      diferencia: cierre.diferencia,
      motivo: cierre.motivoDiferencia,
      usuarioId: input.usuarioId
    }
  });

  return { cierre, transition };
}

/** Reabre una conciliación cerrada y conserva la fotografía de esa transición. */
export async function reopenCashPeriod(
  db: Prisma.TransactionClient | any,
  input: { cierreId: number; inmobiliariaId: number; usuarioId: number; motivo: string }
) {
  const existing = await db.cierreCaja.findFirst({
    where: { id: input.cierreId, inmobiliariaId: input.inmobiliariaId }
  });
  if (!existing) {
    throw new AppError('Cierre no encontrado', { statusCode: 404, code: 'CASH_CLOSING_NOT_FOUND' });
  }
  if (existing.estado !== 'CERRADO') {
    throw new AppError('El período ya está reabierto.', {
      statusCode: 409,
      code: 'CASH_PERIOD_ALREADY_REOPENED',
      details: { cierreId: existing.id, version: existing.version }
    });
  }

  const claimed = await db.cierreCaja.updateMany({
    where: { id: existing.id, estado: 'CERRADO', version: existing.version },
    data: {
      estado: 'REABIERTO',
      reabiertoEn: new Date(),
      reabiertoPorId: input.usuarioId,
      motivoReapertura: input.motivo,
      version: { increment: 1 }
    }
  });
  if (claimed.count !== 1) {
    throw new AppError('El estado del cierre cambió mientras se procesaba la reapertura. Actualizá la pantalla e intentá nuevamente.', {
      statusCode: 409,
      code: 'CASH_CLOSING_CHANGED'
    });
  }

  const cierre = await db.cierreCaja.findUniqueOrThrow({ where: { id: existing.id } });
  await db.eventoCierreCaja.create({
    data: {
      cierreCajaId: cierre.id,
      tipo: 'REAPERTURA',
      version: cierre.version,
      saldoSistema: cierre.saldoSistema,
      saldoDeclarado: cierre.saldoDeclarado,
      diferencia: cierre.diferencia,
      motivo: input.motivo,
      usuarioId: input.usuarioId
    }
  });
  return cierre;
}

export async function isCashPeriodClosed(db: Prisma.TransactionClient | any, input: CashPeriodInput) {
  const scope = closingScope(input);
  // Un cierre bancario legado no tenía cuenta concreta. Se conserva como
  // bloqueo consolidado de ese mes hasta que sea reabierto, sin hacer que los
  // cierres nuevos de una cuenta afecten a las demás.
  const where = input.cuenta === CuentaCaja.BANCO && input.cuentaBancariaId
    ? { ...scope, OR: [{ cuentaBancariaId: input.cuentaBancariaId }, { cuentaBancariaId: null }] }
    : scope;
  const cierre = await findClosing(db, where);
  return cierre?.estado === 'CERRADO';
}

export async function assertCashPeriodOpen(db: Prisma.TransactionClient | any, input: CashPeriodInput) {
  if (await isCashPeriodClosed(db, input)) {
    throw new AppError('El período de caja está cerrado. Reabrilo con autorización antes de registrar movimientos.', {
      statusCode: 409,
      code: 'CASH_PERIOD_CLOSED'
    });
  }
}

/**
 * Una corrección nunca reescribe un mes cerrado. El asiento inverso se debe
 * registrar en la fecha actual (que también debe estar abierta); el llamador
 * usa `originalPeriodClosed` para decidir si puede marcar el original anulado.
 */
export async function prepareCashCorrection(
  db: Prisma.TransactionClient | any,
  input: { inmobiliariaId: number; movimientoOriginal: CashMovementPeriod; fechaCorreccion: Date }
) {
  const originalPeriodClosed = await isCashPeriodClosed(db, {
    inmobiliariaId: input.inmobiliariaId,
    ...input.movimientoOriginal
  });

  await assertCashPeriodOpen(db, {
    inmobiliariaId: input.inmobiliariaId,
    fecha: input.fechaCorreccion,
    cuenta: input.movimientoOriginal.cuenta,
    moneda: input.movimientoOriginal.moneda,
    cuentaBancariaId: input.movimientoOriginal.cuentaBancariaId
  });

  return { originalPeriodClosed, fechaCorreccion: input.fechaCorreccion };
}

/** Operaciones de edición/borrado que alterarían un asiento existente. */
export async function assertCashEntryCanBeRewritten(
  db: Prisma.TransactionClient | any,
  input: CashPeriodInput
) {
  if (await isCashPeriodClosed(db, input)) {
    throw new AppError('El asiento pertenece a un período de caja cerrado. Registrá un ajuste con fecha actual en lugar de modificarlo o eliminarlo.', {
      statusCode: 409,
      code: 'CASH_PERIOD_CLOSED_CORRECTION_REQUIRED'
    });
  }
}
