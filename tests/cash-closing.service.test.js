const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertCashEntryCanBeRewritten,
  closeCashPeriod,
  prepareCashCorrection,
  reopenCashPeriod,
} = require('../dist/services/cash-closing.service');

const closedPeriodDb = (closedPeriods) => ({
  cierreCaja: {
    findUnique: async ({ where }) => {
      const key = where.inmobiliariaId_periodo_cuenta_moneda;
      const period = key.periodo.toISOString().slice(0, 7);
      return closedPeriods.has(`${period}:${key.cuenta}:${key.moneda}`) ? { estado: 'CERRADO' } : null;
    },
  },
});

test('a correction keeps the original closed period immutable and requires today to be open', async () => {
  const db = closedPeriodDb(new Set(['2026-08:CAJA:ARS']));

  const context = await prepareCashCorrection(db, {
    inmobiliariaId: 1,
    movimientoOriginal: { fecha: new Date('2026-08-15T00:00:00.000Z'), cuenta: 'CAJA', moneda: 'ARS' },
    fechaCorreccion: new Date('2026-09-21T00:00:00.000Z'),
  });

  assert.equal(context.originalPeriodClosed, true);
  assert.equal(context.fechaCorreccion.toISOString().slice(0, 10), '2026-09-21');
});

test('an edit or deletion of a closed cash entry is rejected in favor of an adjustment', async () => {
  const db = closedPeriodDb(new Set(['2026-08:BANCO:USD']));

  await assert.rejects(
    () => assertCashEntryCanBeRewritten(db, {
      inmobiliariaId: 1,
      fecha: new Date('2026-08-15T00:00:00.000Z'),
      cuenta: 'BANCO',
      moneda: 'USD',
    }),
    error => error.code === 'CASH_PERIOD_CLOSED_CORRECTION_REQUIRED' && error.statusCode === 409,
  );
});

function closureDb(initialClosure = null) {
  let closure = initialClosure ? { ...initialClosure } : null;
  const events = [];
  let nextId = closure?.id ? closure.id + 1 : 1;

  const matchesUniqueKey = where => {
    const key = where.inmobiliariaId_periodo_cuenta_moneda;
    return closure
      && closure.inmobiliariaId === key.inmobiliariaId
      && closure.periodo.getTime() === key.periodo.getTime()
      && closure.cuenta === key.cuenta
      && closure.moneda === key.moneda;
  };

  const db = {
    cierreCaja: {
      findUnique: async ({ where }) => {
        if (where.id) return closure?.id === where.id ? { ...closure } : null;
        return matchesUniqueKey(where) ? { ...closure } : null;
      },
      findUniqueOrThrow: async ({ where }) => {
        if (!closure || closure.id !== where.id) throw new Error('not found');
        return { ...closure };
      },
      findFirst: async ({ where }) => (
        closure && closure.id === where.id && closure.inmobiliariaId === where.inmobiliariaId ? { ...closure } : null
      ),
      create: async ({ data }) => {
        closure = {
          id: nextId++,
          estado: 'CERRADO',
          cerradoEn: new Date('2026-09-24T12:00:00.000Z'),
          reabiertoEn: null,
          reabiertoPorId: null,
          motivoReapertura: null,
          ...data
        };
        return { ...closure };
      },
      updateMany: async ({ where, data }) => {
        if (!closure || closure.id !== where.id || closure.estado !== where.estado || closure.version !== where.version) return { count: 0 };
        closure = {
          ...closure,
          ...data,
          version: typeof data.version === 'object' ? closure.version + data.version.increment : data.version
        };
        return { count: 1 };
      }
    },
    eventoCierreCaja: {
      create: async ({ data }) => {
        const event = { id: events.length + 1, ...data };
        events.push(event);
        return event;
      }
    }
  };

  return {
    db,
    events,
    get closure() { return closure ? { ...closure } : null; }
  };
}

const closingInput = overrides => ({
  inmobiliariaId: 1,
  periodo: new Date('2026-08-01T00:00:00.000Z'),
  cuenta: 'CAJA',
  moneda: 'ARS',
  saldoSistema: 150000,
  saldoDeclarado: 150000,
  diferencia: 0,
  motivoDiferencia: null,
  usuarioId: 7,
  ...overrides
});

test('a closed cash period is immutable until an authorized reopening', async () => {
  const fixture = closureDb({
    id: 41,
    version: 1,
    estado: 'CERRADO',
    inmobiliariaId: 1,
    periodo: new Date('2026-08-01T00:00:00.000Z'),
    cuenta: 'CAJA',
    moneda: 'ARS',
    saldoSistema: 150000,
    saldoDeclarado: 150000,
    diferencia: 0,
    motivoDiferencia: null,
    cerradoPorId: 7
  });

  await assert.rejects(
    () => closeCashPeriod(fixture.db, closingInput({ saldoDeclarado: 1 })),
    error => error.code === 'CASH_PERIOD_ALREADY_CLOSED' && error.statusCode === 409,
  );

  assert.equal(fixture.closure.saldoDeclarado, 150000);
  assert.equal(fixture.closure.version, 1);
  assert.equal(fixture.events.length, 0);
});

test('a reopened period creates immutable close and reopen versions instead of replacing history', async () => {
  const fixture = closureDb();
  const first = await closeCashPeriod(fixture.db, closingInput());
  assert.equal(first.transition, 'CREADO');
  assert.equal(first.cierre.version, 1);

  const reopened = await reopenCashPeriod(fixture.db, {
    cierreId: first.cierre.id,
    inmobiliariaId: 1,
    usuarioId: 9,
    motivo: 'Se detectó un comprobante bancario omitido.'
  });
  assert.equal(reopened.estado, 'REABIERTO');
  assert.equal(reopened.version, 2);

  const reclosed = await closeCashPeriod(fixture.db, closingInput({ saldoSistema: 160000, saldoDeclarado: 160000, usuarioId: 11 }));
  assert.equal(reclosed.transition, 'RECERRADO');
  assert.equal(reclosed.cierre.estado, 'CERRADO');
  assert.equal(reclosed.cierre.version, 3);
  assert.equal(reclosed.cierre.motivoReapertura, 'Se detectó un comprobante bancario omitido.');

  assert.deepEqual(
    fixture.events.map(event => [event.tipo, event.version, event.saldoDeclarado, event.usuarioId]),
    [['CIERRE', 1, 150000, 7], ['REAPERTURA', 2, 150000, 9], ['CIERRE', 3, 160000, 11]]
  );
});

test('a concurrent reopen or close is rejected instead of overwriting a newer version', async () => {
  const fixture = closureDb({
    id: 72,
    version: 2,
    estado: 'REABIERTO',
    inmobiliariaId: 1,
    periodo: new Date('2026-08-01T00:00:00.000Z'),
    cuenta: 'CAJA',
    moneda: 'ARS',
    saldoSistema: 150000,
    saldoDeclarado: 150000,
    diferencia: 0,
    cerradoPorId: 7
  });
  fixture.db.cierreCaja.updateMany = async () => ({ count: 0 });

  await assert.rejects(
    () => closeCashPeriod(fixture.db, closingInput()),
    error => error.code === 'CASH_CLOSING_CHANGED' && error.statusCode === 409,
  );
  assert.equal(fixture.events.length, 0);
});
