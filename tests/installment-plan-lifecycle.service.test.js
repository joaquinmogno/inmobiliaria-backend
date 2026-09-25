const test = require('node:test');
const assert = require('node:assert/strict');

const {
  syncInstallmentPlanCompletion,
  syncInstallmentsForLiquidationSettlement,
} = require('../dist/services/installment-plan-lifecycle.service');

test('a plan is fulfilled only when every installment was collected, and reopens after a reversal', async () => {
  const updates = [];
  const tx = {
    planCuotas: {
      findMany: async () => [{ id: 14, estado: 'VIGENTE', cuotas: [{ estado: 'PAGADA' }, { estado: 'PAGADA' }] }],
      update: async data => updates.push(data),
    },
  };

  await syncInstallmentPlanCompletion(tx, [14], 7);
  assert.equal(updates[0].data.estado, 'CUMPLIDO');
  assert.equal(updates[0].data.cerradoPorId, 7);

  tx.planCuotas.findMany = async () => [{ id: 14, estado: 'CUMPLIDO', cuotas: [{ estado: 'PAGADA' }, { estado: 'PENDIENTE' }] }];
  await syncInstallmentPlanCompletion(tx, [14], 7);
  assert.equal(updates[1].data.estado, 'VIGENTE');
  assert.equal(updates[1].data.fechaCierre, null);
});

test('settling or reopening a liquidation synchronizes its linked installment state', async () => {
  const updates = [];
  const tx = {
    liquidacion: {
      findUnique: async () => ({ id: 154, netoACobrar: 100000, pagos: [{ monto: 100000 }], aplicacionesCredito: [] }),
    },
    cuotaPlan: {
      findMany: async () => [{ id: 18, planId: 14, estado: 'PENDIENTE' }],
      updateMany: async data => updates.push(data),
    },
    planCuotas: { findMany: async () => [] },
  };

  await syncInstallmentsForLiquidationSettlement({ tx, liquidacionId: 154, usuarioId: 7 });
  assert.equal(updates[0].data.estado, 'PAGADA');
  assert.deepEqual(updates[0].where.estado.in, ['PENDIENTE']);

  tx.liquidacion.findUnique = async () => ({ id: 154, netoACobrar: 100000, pagos: [{ monto: 20000 }], aplicacionesCredito: [] });
  tx.cuotaPlan.findMany = async () => [{ id: 18, planId: 14, estado: 'PAGADA' }];
  await syncInstallmentsForLiquidationSettlement({ tx, liquidacionId: 154, usuarioId: 7 });
  assert.equal(updates[1].data.estado, 'PENDIENTE');
  assert.deepEqual(updates[1].where.estado.in, ['PAGADA']);
});
