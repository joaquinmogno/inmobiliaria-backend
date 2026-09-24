const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertContractCanBeRescinded,
  getContractOutstandingObligations,
  hasContractFinancialHistory,
} = require('../dist/services/contract-financial-integrity.service');
const { contractRescissionSchema } = require('../dist/validation/contratos.schemas');

const financialTx = {
  liquidacion: {
    findMany: async () => [{
      id: 154,
      periodo: new Date('2026-09-01T00:00:00.000Z'),
      moneda: 'ARS',
      netoACobrar: 100000,
      montoPropietario: 90000,
      montoPagadoPropietario: 0,
      pagos: [{ monto: 25000 }],
      aplicacionesCredito: [],
    }],
  },
  cuotaPlan: { count: async () => 2 },
  creditoInquilino: { findMany: async () => [{ id: 18, saldoPendiente: 5000, moneda: 'ARS' }] },
};

test('rescission is blocked while tenant, owner, installment or credit obligations remain', async () => {
  const obligations = await getContractOutstandingObligations(financialTx, 20);

  assert.equal(obligations.cobrosPendientesInquilino[0].saldo, '75000.00');
  assert.equal(obligations.pagosPendientesPropietario[0].saldo, '90000.00');
  assert.equal(obligations.cuotasPendientes, 2);
  assert.equal(obligations.saldosAFavorInquilino[0].saldo, '5000.00');
  await assert.rejects(() => assertContractCanBeRescinded(financialTx, 20), error => error.code === 'CONTRACT_OUTSTANDING_OBLIGATIONS');
});

test('financial history is never eligible for trash, even when balances were already settled', () => {
  assert.equal(hasContractFinancialHistory({ liquidaciones: 1, pagos: 0, movimientosCaja: 0, planesCuotas: 0 }), true);
  assert.equal(hasContractFinancialHistory({ liquidaciones: 0, pagos: 0, movimientosCaja: 0, planesCuotas: 0 }), false);
});

test('rescission requires an auditable reason and an optimistic-lock version', () => {
  assert.equal(contractRescissionSchema.safeParse({ motivo: 'Acuerdo anticipado de ambas partes', fechaRescision: '2026-09-24', version: 4 }).success, true);
  assert.equal(contractRescissionSchema.safeParse({ motivo: 'No', version: 4 }).success, false);
});
