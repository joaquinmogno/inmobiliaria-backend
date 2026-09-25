const test = require('node:test');
const assert = require('node:assert/strict');
const { Decimal } = require('@prisma/client/runtime/library');
const {
  getActiveOwnerPaymentSettlement,
  getOwnerPaymentSettlement,
  getOwnerPaymentState,
  getTenantCollectionState,
  getTenantSettlement,
} = require('../dist/services/tenant-credit.service');

test('tenant credit applications reduce debt without being counted as a cash payment', () => {
  const liquidation = {
    netoACobrar: new Decimal(100000),
    montoPropietario: new Decimal(90000),
    montoPagadoPropietario: new Decimal(0),
    pagos: [{ monto: new Decimal(40000) }],
    aplicacionesCredito: [{ monto: new Decimal(10000) }],
  };

  const settlement = getTenantSettlement(liquidation);
  assert.equal(settlement.pagos.toString(), '40000');
  assert.equal(settlement.creditosAplicados.toString(), '10000');
  assert.equal(settlement.saldo.toString(), '50000');
  assert.equal(getTenantCollectionState(liquidation), 'PARCIAL');
});

test('a credit can fully settle a tenant balance without fabricating a cash collection', () => {
  const liquidation = {
    netoACobrar: new Decimal(100000),
    montoPropietario: new Decimal(90000),
    montoPagadoPropietario: new Decimal(0),
    pagos: [{ monto: new Decimal(90000) }],
    aplicacionesCredito: [{ monto: new Decimal(10000) }],
  };

  const settlement = getTenantSettlement(liquidation);
  assert.equal(settlement.pagos.toString(), '90000');
  assert.equal(settlement.totalAplicado.toString(), '100000');
  assert.equal(settlement.saldo.toString(), '0');
  assert.equal(getTenantCollectionState(liquidation), 'COBRADO');
});

test('a fully credited zero obligation is not reported as pending or collected', () => {
  const liquidation = {
    netoACobrar: new Decimal(0),
    montoPropietario: new Decimal(0),
    pagos: [],
    aplicacionesCredito: [],
    pagosPropietario: [],
  };

  assert.equal(getTenantSettlement(liquidation).saldo.toString(), '0');
  assert.equal(getTenantCollectionState(liquidation), 'NO_APLICA');
  assert.equal(getOwnerPaymentSettlement(liquidation).saldo.toString(), '0');
  assert.equal(getOwnerPaymentState(liquidation), 'NO_APLICA');
});

test('legacy split collections reconcile as collected and settle the reconstructed owner payment', () => {
  // Regresión de la liquidación histórica: dos pagos vigentes que totalizan
  // el neto no pueden conservar el estado PENDIENTE después de la migración.
  const liquidation = {
    netoACobrar: new Decimal(850000),
    montoPropietario: new Decimal(850000),
    pagos: [{ monto: new Decimal(300000) }, { monto: new Decimal(550000) }],
    aplicacionesCredito: [],
    pagosPropietario: [{ monto: new Decimal(850000) }],
  };

  const tenantSettlement = getTenantSettlement(liquidation);
  const ownerSettlement = getOwnerPaymentSettlement(liquidation);
  assert.equal(tenantSettlement.saldo.toString(), '0');
  assert.equal(getTenantCollectionState(liquidation), 'COBRADO');
  assert.equal(ownerSettlement.pagado.toString(), '850000');
  assert.equal(ownerSettlement.saldo.toString(), '0');
  assert.equal(getOwnerPaymentState(liquidation), 'PAGADO');
});

const activeOwnerPaymentsDatabase = (pagosPropietario) => {
  const calls = [];
  return {
    calls,
    db: {
      pagoPropietario: {
        findMany: async (query) => {
          calls.push(query);
          return pagosPropietario;
        },
      },
    },
  };
};

test('anular una entrega total vuelve el saldo del propietario al total pendiente', async () => {
  // La consulta posterior a la anulación no encuentra entregas vigentes.
  const { db, calls } = activeOwnerPaymentsDatabase([]);

  const settlement = await getActiveOwnerPaymentSettlement(db, {
    inmobiliariaId: 1,
    liquidacionId: 101,
    montoPropietario: new Decimal(100000),
  });

  assert.equal(settlement.pagado.toString(), '0');
  assert.equal(settlement.saldo.toString(), '100000');
  assert.equal(settlement.estado, 'PENDIENTE');
  assert.deepEqual(calls, [{
    where: { inmobiliariaId: 1, liquidacionId: 101, anuladoEn: null },
    select: { id: true, monto: true },
    orderBy: { id: 'asc' },
  }]);
});

test('anular una entrega parcial conserva las entregas vigentes y el saldo correcto', async () => {
  // Quedó vigente una entrega de $40.000 después de anular otra.
  const { db } = activeOwnerPaymentsDatabase([
    { id: 11, monto: new Decimal(40000) },
  ]);

  const settlement = await getActiveOwnerPaymentSettlement(db, {
    inmobiliariaId: 1,
    liquidacionId: 101,
    montoPropietario: new Decimal(100000),
  });

  assert.equal(settlement.pagado.toString(), '40000');
  assert.equal(settlement.saldo.toString(), '60000');
  assert.equal(settlement.estado, 'PARCIAL');
});

test('anular una de varias entregas recalcula sólo con los IDs vigentes en base', async () => {
  // La entrega #12 fue anulada; #11 y #13 continúan vigentes.
  const { db } = activeOwnerPaymentsDatabase([
    { id: 11, monto: new Decimal(40000) },
    { id: 13, monto: new Decimal(20000) },
  ]);

  const settlement = await getActiveOwnerPaymentSettlement(db, {
    inmobiliariaId: 1,
    liquidacionId: 101,
    montoPropietario: new Decimal(100000),
  });

  assert.deepEqual(settlement.pagosPropietario.map(({ id }) => id), [11, 13]);
  assert.equal(settlement.pagado.toString(), '60000');
  assert.equal(settlement.saldo.toString(), '40000');
  assert.equal(settlement.estado, 'PARCIAL');
});
