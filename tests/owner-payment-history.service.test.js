const test = require('node:test');
const assert = require('node:assert/strict');

const { buildOwnerPaymentHistory } = require('../dist/services/owner-payment-history.service');

const operator = { id: 7, nombreCompleto: 'María Administración' };

test('owner payment history retains partial payments, reversals and the balance after each event', () => {
  const history = buildOwnerPaymentHistory(100000, [
    {
      id: 11, tipo: 'EGRESO', monto: 40000, fecha: new Date('2026-09-05'), fechaCreacion: new Date('2026-09-05T10:00:00Z'),
      metodoPago: 'TRANSFERENCIA', cuenta: 'BANCO', comprobante: 'TRX-001', observaciones: 'Transferencia parcial', anuladoEn: null, motivoAnulacion: null,
      creadoPor: operator, anuladoPor: null, reversionDe: null, reversion: { id: 13 }
    },
    {
      id: 12, tipo: 'EGRESO', monto: 60000, fecha: new Date('2026-09-08'), fechaCreacion: new Date('2026-09-08T10:00:00Z'),
      metodoPago: 'EFECTIVO', cuenta: 'CAJA', comprobante: null, observaciones: null, anuladoEn: null, motivoAnulacion: null,
      creadoPor: operator, anuladoPor: null, reversionDe: null, reversion: null
    },
    {
      id: 13, tipo: 'INGRESO', monto: 40000, fecha: new Date('2026-09-10'), fechaCreacion: new Date('2026-09-10T10:00:00Z'),
      metodoPago: 'TRANSFERENCIA', cuenta: 'BANCO', comprobante: null, observaciones: 'Cuenta bancaria rechazada', anuladoEn: null, motivoAnulacion: null,
      creadoPor: operator, anuladoPor: null, reversionDe: { id: 11 }, reversion: null
    }
  ]);

  assert.deepEqual(history.map(item => [item.id, item.tipo, item.estado, item.saldoPosterior]), [
    [13, 'REVERSION', 'REVERSION', 40000],
    [12, 'PAGO', 'VIGENTE', 0],
    [11, 'PAGO', 'REVERTIDO', 60000]
  ]);
  assert.equal(history[0].reversionDeId, 11);
  assert.equal(history[2].reversionId, 13);
  assert.equal(history[1].comprobante, 'Asiento #12');
  assert.equal(history[2].comprobante, 'TRX-001');
});
