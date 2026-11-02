const test = require('node:test');
const assert = require('node:assert/strict');
const { updateLiquidationNote } = require('../dist/services/liquidation-note.service');
const { notaLiquidacionSchema } = require('../dist/validation/liquidaciones.schemas');
const { getLiquidationNoteForRecipient } = require('../dist/services/liquidacion-pdf.service');

const input = { liquidacionId: 10, inmobiliariaId: 1, usuarioId: 7, expectedVersion: 2, notaLiquidacion: 'Cotización informada para este mes', destinatarioNotaLiquidacion: 'PROPIETARIO' };

function draft(overrides = {}) {
  const current = {
    id: 10, inmobiliariaId: 1, version: 2, estado: 'BORRADOR', notaLiquidacion: null, destinatarioNotaLiquidacion: 'AMBOS',
    netoACobrar: 2300, montoPropietario: 2185, montoHonorarios: 115,
    estadoCobroInquilino: 'PENDIENTE', estadoPagoPropietario: 'PENDIENTE', ...overrides,
  };
  const writes = [];
  const audit = [];
  const queries = [];
  return {
    current, writes, audit, queries,
    tx: {
      liquidacion: {
        findFirst: async query => { queries.push(query); return { ...current }; },
        updateMany: async query => {
          writes.push(query);
          Object.assign(current, query.data, { version: current.version + 1 });
          return { count: 1 };
        },
        findUniqueOrThrow: async () => current,
      },
      auditLog: { create: async query => { audit.push(query); return query.data; } },
    },
  };
}

test('la nota se guarda por inmobiliaria sin tocar importes, cobros, caja ni honorarios', async () => {
  const fixture = draft();
  const result = await updateLiquidationNote(fixture.tx, input);
  assert.deepEqual(fixture.queries[0].where, { id: 10, inmobiliariaId: 1 });
  assert.deepEqual(fixture.writes[0].where, { id: 10, inmobiliariaId: 1, version: 2, estado: 'BORRADOR' });
  assert.deepEqual(fixture.writes[0].data, {
    notaLiquidacion: input.notaLiquidacion, destinatarioNotaLiquidacion: 'PROPIETARIO', version: { increment: 1 },
  });
  assert.equal(result.liquidacion.netoACobrar, 2300);
  assert.equal(result.liquidacion.montoHonorarios, 115);
  assert.equal(result.liquidacion.montoPropietario, 2185);
  assert.equal(result.liquidacion.estadoCobroInquilino, 'PENDIENTE');
  assert.equal(result.comprobanteVersion, null);
  assert.equal(fixture.audit[0].data.accion, 'GUARDAR_NOTA_LIQUIDACION');
});

test('quitar una nota elimina el texto actual y conserva el anterior en auditoría', async () => {
  const fixture = draft({ notaLiquidacion: 'Nota anterior', destinatarioNotaLiquidacion: 'INQUILINO' });
  await updateLiquidationNote(fixture.tx, { ...input, notaLiquidacion: null });
  assert.equal(fixture.current.notaLiquidacion, null);
  assert.equal(fixture.current.destinatarioNotaLiquidacion, 'AMBOS');
  assert.equal(fixture.audit[0].data.accion, 'QUITAR_NOTA_LIQUIDACION');
  assert.equal(JSON.parse(fixture.audit[0].data.detalle).notaLiquidacion.anterior, 'Nota anterior');
});

test('guardar sin cambios no crea otra versión ni registra una edición ficticia', async () => {
  const fixture = draft({ notaLiquidacion: input.notaLiquidacion, destinatarioNotaLiquidacion: 'PROPIETARIO' });
  await updateLiquidationNote(fixture.tx, input);
  assert.equal(fixture.writes.length, 0);
  assert.equal(fixture.audit.length, 0);
});

test('rechaza una edición desactualizada, una anulación y una liquidación ajena sin escribir', async () => {
  for (const [overrides, code] of [[{ version: 3 }, 'STALE_WRITE'], [{ estado: 'ANULADA' }, 'LIQUIDATION_NOT_EDITABLE']]) {
    const fixture = draft(overrides);
    await assert.rejects(updateLiquidationNote(fixture.tx, input), error => error.code === code);
    assert.equal(fixture.writes.length, 0);
  }
  const fixture = draft();
  fixture.tx.liquidacion.findFirst = async () => null;
  await assert.rejects(updateLiquidationNote(fixture.tx, input), error => error.statusCode === 404);
  assert.equal(fixture.writes.length, 0);
});

test('rechaza una carrera de actualización antes de emitir comprobantes o auditoría', async () => {
  const fixture = draft();
  fixture.tx.liquidacion.updateMany = async () => ({ count: 0 });
  await assert.rejects(updateLiquidationNote(fixture.tx, input), error => error.code === 'STALE_WRITE');
  assert.equal(fixture.audit.length, 0);
});

test('valida destinatario, longitud, texto y versión; recorta espacios y admite quitar la nota', () => {
  const valid = { notaLiquidacion: '  Aclaración\nSegunda línea  ', destinatarioNotaLiquidacion: 'AMBOS', expectedVersion: 2 };
  assert.equal(notaLiquidacionSchema.parse(valid).notaLiquidacion, 'Aclaración\nSegunda línea');
  assert.equal(notaLiquidacionSchema.parse({ ...valid, notaLiquidacion: null }).notaLiquidacion, null);
  assert.equal(notaLiquidacionSchema.parse({ ...valid, notaLiquidacion: '  ' }).notaLiquidacion, null);
  for (const change of [{ notaLiquidacion: 'a'.repeat(3001) }, { notaLiquidacion: 123 }, { destinatarioNotaLiquidacion: 'TODOS' }, { expectedVersion: undefined }]) {
    assert.equal(notaLiquidacionSchema.safeParse({ ...valid, ...change }).success, false);
  }
});

test('cada PDF recibe exclusivamente las aclaraciones de su destinatario', () => {
  for (const audience of ['INQUILINO', 'PROPIETARIO', 'AMBOS']) {
    for (const recipient of ['INQUILINO', 'PROPIETARIO']) {
      const note = getLiquidationNoteForRecipient({ notaLiquidacion: 'Nota privada', destinatarioNotaLiquidacion: audience }, recipient);
      assert.equal(note, audience === 'AMBOS' || audience === recipient ? 'Nota privada' : null);
    }
  }
  assert.equal(getLiquidationNoteForRecipient({}, 'INQUILINO'), null);
  assert.equal(getLiquidationNoteForRecipient({ notaLiquidacion: 'x', destinatarioNotaLiquidacion: 'INVALIDO' }, 'INQUILINO'), null);
});
