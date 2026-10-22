const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getContractOutstandingObligations,
  hasContractFinancialHistory,
} = require('../dist/services/contract-financial-integrity.service');
const { contractRescissionSchema, keyDeliverySchema } = require('../dist/validation/contratos.schemas');

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

test('rescission preparation exposes tenant, owner, installment and credit obligations', async () => {
  const obligations = await getContractOutstandingObligations(financialTx, 20);

  assert.equal(obligations.cobrosPendientesInquilino[0].saldo, '75000.00');
  assert.equal(obligations.pagosPendientesPropietario[0].saldo, '90000.00');
  assert.equal(obligations.cuotasPendientes, 2);
  assert.equal(obligations.saldosAFavorInquilino[0].saldo, '5000.00');
});

test('financial history is never eligible for trash, even when balances were already settled', () => {
  assert.equal(hasContractFinancialHistory({ liquidaciones: 1, pagos: 0, movimientosCaja: 0, planesCuotas: 0 }), true);
  assert.equal(hasContractFinancialHistory({ liquidaciones: 0, pagos: 0, movimientosCaja: 0, planesCuotas: 0 }), false);
});

test('key delivery and no-claims closure require separate explicit confirmations', () => {
  const keys = { fechaEntregaLlaves: '2026-09-24', cantidadLlaves: 2, receptorNombre: 'Administrador', estadoInmueble: 'Desocupado', inmuebleDesocupado: true, version: 4 };
  assert.equal(keyDeliverySchema.safeParse(keys).success, true);
  assert.equal(keyDeliverySchema.safeParse({ ...keys, inmuebleDesocupado: false }).success, false);
  const valid = { tipoCierre: 'ANTICIPADA_INQUILINO', sinReclamosConfirmado: true, serviciosSaldadosConfirmados: true, depositoResueltoConfirmado: true, motivo: 'Rescisión voluntaria del inquilino', fechaRescision: '2026-09-24', llavesEntregadas: true, fechaEntregaLlaves: '2026-09-24', cantidadLlaves: 2, estadoInmueble: 'Desocupado', multaImporte: 0, multaResponsable: null, depositoADevolver: 0, depositoRetenido: 0, pendientesManuales: [], version: 5 };
  assert.equal(contractRescissionSchema.safeParse(valid).success, true);
  assert.equal(contractRescissionSchema.safeParse({ ...valid, sinReclamosConfirmado: false }).success, false);
  assert.equal(contractRescissionSchema.safeParse({ ...valid, pendientesManuales: [{ tipo: 'SERVICIO', concepto: 'Luz', responsable: 'INQUILINO', importe: 100 }] }).success, false);
  assert.equal(contractRescissionSchema.safeParse({ ...valid, depositoRetenido: 100 }).success, false);
  assert.equal(contractRescissionSchema.safeParse({ motivo: 'No', version: 4 }).success, false);
});
