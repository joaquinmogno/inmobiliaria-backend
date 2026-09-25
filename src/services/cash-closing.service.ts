import { CuentaCaja, Moneda, Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';

export const monthStart = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));

export type CashPeriodInput = {
  inmobiliariaId: number;
  fecha: Date;
  cuenta: CuentaCaja;
  moneda: Moneda;
};

export type CashMovementPeriod = Pick<CashPeriodInput, 'fecha' | 'cuenta' | 'moneda'>;

type CashClosingSnapshot = {
  inmobiliariaId: number;
  periodo: Date;
  cuenta: CuentaCaja;
  moneda: Moneda;
  saldoSistema: unknown;
  saldoDeclarado: unknown;
  diferencia: unknown;
  motivoDiferencia?: string | null;
  usuarioId: number;
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
  const uniqueKey = {
    inmobiliariaId_periodo_cuenta_moneda: {
      inmobiliariaId: input.inmobiliariaId,
      periodo: input.periodo,
      cuenta: input.cuenta,
      moneda: input.moneda
    }
  };
  const existing = await db.cierreCaja.findUnique({ where: uniqueKey });

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
  const cierre = await db.cierreCaja.findUnique({ where: { inmobiliariaId_periodo_cuenta_moneda: { inmobiliariaId: input.inmobiliariaId, periodo: monthStart(input.fecha), cuenta: input.cuenta, moneda: input.moneda } } });
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
    moneda: input.movimientoOriginal.moneda
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
