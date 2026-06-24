process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-currency-api-suite';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');

const { prisma } = require('../dist/prisma');
const { auditService } = require('../dist/services/audit.service');
const permissionsService = require('../dist/services/permissions.service');
const contratosRoutes = require('../dist/routes/contratos.routes').default;
const liquidacionesRoutes = require('../dist/routes/liquidaciones.routes').default;
const pagosRoutes = require('../dist/routes/pagos.routes').default;
const cajaRoutes = require('../dist/routes/cajachica.routes').default;

const createdContracts = [];
const createdLiquidaciones = [];
const createdMovimientos = [];
const createdPagos = [];
const createdCaja = [];

function createToken() {
  return jwt.sign(
    {
      id: 7001,
      email: 'moneda.test@inmobiliaria.local',
      role: 'SUPERADMIN',
      inmobiliariaId: 1,
    },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
}

async function request(app, path, options = {}) {
  const response = await fetch(`http://127.0.0.1:${app.address.port}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${createToken()}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
  };
}

async function withServer(run) {
  const app = express();
  app.use(express.json());
  app.use('/api/contratos', contratosRoutes);
  app.use('/api/liquidaciones', liquidacionesRoutes);
  app.use('/api/pagos', pagosRoutes);
  app.use('/api/caja-chica', cajaRoutes);

  const server = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  try {
    await run({ address: server.address() });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function resetState() {
  createdContracts.length = 0;
  createdLiquidaciones.length = 0;
  createdMovimientos.length = 0;
  createdPagos.length = 0;
  createdCaja.length = 0;
}

function installPrismaMocks() {
  const allPermissions = permissionsService.MODULE_PERMISSIONS.map((clave) => ({ permiso: { clave } }));
  prisma.rolPermiso = { findMany: async () => allPermissions };
  prisma.usuarioPermiso = { findMany: async () => [] };
  prisma.usuarioPermisoDenegado = { findMany: async () => [] };

  prisma.$transaction = async (callback) => callback(prisma);

  prisma.propiedad = {
    findFirst: async () => ({ id: 10, direccion: 'Av. Test 123' }),
    create: async ({ data }) => ({ id: 10, ...data }),
  };
  prisma.persona = {
    findMany: async ({ where }) => (where.id.in || []).map((id) => ({ id })),
    create: async ({ data }) => ({ id: createdContracts.length + 100, ...data }),
  };
  prisma.contrato = {
    create: async ({ data }) => {
      const contrato = {
        id: createdContracts.length + 1,
        ...data,
        moneda: data.moneda || 'ARS',
        montoAlquiler: data.montoAlquiler.toString(),
        montoHonorarios: data.montoHonorarios.toString(),
      };
      createdContracts.push(contrato);
      return contrato;
    },
    findFirst: async ({ where }) => createdContracts.find((item) => item.id === where.id) || null,
    update: async ({ where, data }) => {
      const contrato = createdContracts.find((item) => item.id === where.id);
      Object.assign(contrato, data);
      return contrato;
    },
  };
  prisma.liquidacion = {
    count: async ({ where }) => createdLiquidaciones.filter((item) => item.contratoId === where.contratoId).length,
    findFirst: async ({ where }) => {
      if (where.id) return createdLiquidaciones.find((item) => item.id === where.id && item.inmobiliariaId === where.inmobiliariaId) || null;
      if (where.contratoId && where.periodo) return createdLiquidaciones.find((item) => item.contratoId === where.contratoId) || null;
      return null;
    },
    findMany: async ({ where }) => createdLiquidaciones
      .filter((item) => item.contratoId === where.contratoId && item.inmobiliariaId === where.inmobiliariaId && item.estado === where.estado)
      .map((item) => ({
        ...item,
        pagos: createdPagos.filter((pago) => pago.liquidacionId === item.id),
        contrato: {
          propiedad: { direccion: 'Av. Test 123' },
        },
      })),
    create: async ({ data }) => {
      const liquidacion = {
        id: createdLiquidaciones.length + 1,
        ...data,
        moneda: data.moneda || 'ARS',
        totalIngresos: 0,
        totalDescuentos: 0,
        netoACobrar: 0,
        movimientos: [],
      };
      createdLiquidaciones.push(liquidacion);
      return liquidacion;
    },
    update: async ({ where, data }) => {
      const liquidacion = createdLiquidaciones.find((item) => item.id === where.id);
      Object.assign(liquidacion, data);
      return liquidacion;
    },
    aggregate: async () => ({ _sum: { netoACobrar: 0 } }),
  };
  prisma.movimiento = {
    findMany: async ({ where }) => createdMovimientos.filter((item) => item.liquidacionId === where.liquidacionId),
    create: async ({ data }) => {
      const movimiento = { id: createdMovimientos.length + 1, ...data };
      createdMovimientos.push(movimiento);
      return movimiento;
    },
  };
  prisma.cuotaPlan = {
    findUnique: async () => null,
    update: async ({ data }) => data,
  };
  prisma.pago = {
    count: async ({ where }) => createdPagos.filter((item) => item.contratoId === where.contratoId).length,
    create: async ({ data }) => {
      const pago = { id: createdPagos.length + 1, ...data };
      createdPagos.push(pago);
      return pago;
    },
    findMany: async ({ where }) => createdPagos
      .filter((item) => where.id?.in?.includes(item.id))
      .map((item) => ({
        ...item,
        liquidacion: {
          id: item.liquidacionId,
          periodo: new Date('2026-06-01T00:00:00.000Z'),
          contrato: {
            propiedad: { direccion: 'Av. Test 123' },
            inquilinos: [{ persona: { nombreCompleto: 'Inquilino Test' } }],
          },
        },
      })),
  };
  prisma.movimientoCaja = {
    count: async ({ where }) => where?.contratoId
      ? createdCaja.filter((item) => item.contratoId === where.contratoId).length
      : createdCaja.length,
    create: async ({ data }) => {
      const movimiento = { id: createdCaja.length + 1, ...data };
      createdCaja.push(movimiento);
      return movimiento;
    },
    aggregate: async ({ where }) => {
      const sum = createdCaja
        .filter((item) => {
          if (where.inmobiliariaId && item.inmobiliariaId !== where.inmobiliariaId) return false;
          if (where.tipo && item.tipo !== where.tipo) return false;
          if (where.moneda && item.moneda !== where.moneda) return false;
          return true;
        })
        .reduce((acc, item) => acc + Number(item.monto), 0);
      return { _sum: { monto: sum } };
    },
    findMany: async () => createdCaja,
  };
  prisma.planCuotas = {
    count: async ({ where }) => createdLiquidaciones.some((item) => item.contratoId === where.contratoId) ? 0 : 0,
  };

  auditService.log = async () => ({ id: 1 });
  auditService.history = async () => [];
}

function contractPayload(moneda) {
  return {
    fechaInicio: '2026-01-01',
    fechaFin: '2027-01-01',
    fechaActualizacion: '2026-07-01',
    propiedadId: 10,
    propietarioIds: [1],
    inquilinoIds: [2],
    montoAlquiler: 1000,
    montoHonorarios: 100,
    moneda,
    administrado: true,
  };
}

test.beforeEach(() => {
  resetState();
  installPrismaMocks();
});

test('API currency: creates ARS contracts by default', async () => {
  await withServer(async (app) => {
    const response = await request(app, '/api/contratos', {
      method: 'POST',
      body: JSON.stringify(contractPayload(undefined)),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.moneda, 'ARS');
  });
});

test('API currency: creates USD contracts', async () => {
  await withServer(async (app) => {
    const response = await request(app, '/api/contratos', {
      method: 'POST',
      body: JSON.stringify(contractPayload('USD')),
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.moneda, 'USD');
  });
});

test('API currency: liquidations inherit contract currency and initial movement currency', async () => {
  createdContracts.push({ id: 1, inmobiliariaId: 1, moneda: 'USD', montoAlquiler: 1500 });

  await withServer(async (app) => {
    const response = await request(app, '/api/liquidaciones', {
      method: 'POST',
      body: JSON.stringify({ contratoId: 1, periodo: '2026-06-01', montoHonorarios: 0 }),
    });

    assert.equal(response.status, 201);
    assert.equal(createdLiquidaciones[0].moneda, 'USD');
    assert.equal(createdMovimientos[0].moneda, 'USD');
  });
});

test('API currency: payment currency must match pending liquidation currency', async () => {
  createdContracts.push({ id: 1, inmobiliariaId: 1, moneda: 'USD', montoAlquiler: 1500 });
  createdLiquidaciones.push({
    id: 1,
    contratoId: 1,
    inmobiliariaId: 1,
    moneda: 'USD',
    estado: 'PENDIENTE_PAGO',
    netoACobrar: 1500,
    periodo: new Date('2026-06-01T00:00:00.000Z'),
  });

  await withServer(async (app) => {
    const originalConsoleError = console.error;
    console.error = () => {};
    let response;
    try {
      response = await request(app, '/api/pagos', {
        method: 'POST',
        body: JSON.stringify({ contratoId: 1, monto: 500, moneda: 'ARS', metodoPago: 'EFECTIVO' }),
      });
    } finally {
      console.error = originalConsoleError;
    }

    assert.equal(response.status, 400);
    assert.match(response.body.message, /USD/);
    assert.match(response.body.message, /mezclar monedas/);
  });
});

test('API currency: cashbox manual movements keep separate currencies', async () => {
  await withServer(async (app) => {
    const ars = await request(app, '/api/caja-chica', {
      method: 'POST',
      body: JSON.stringify({ tipo: 'INGRESO', concepto: 'Ingreso ARS', monto: 1000, moneda: 'ARS', fecha: '2026-06-10' }),
    });
    const usd = await request(app, '/api/caja-chica', {
      method: 'POST',
      body: JSON.stringify({ tipo: 'EGRESO', concepto: 'Egreso USD', monto: 50, moneda: 'USD', fecha: '2026-06-10' }),
    });

    assert.equal(ars.status, 201);
    assert.equal(usd.status, 201);
    assert.equal(createdCaja[0].moneda, 'ARS');
    assert.equal(createdCaja[1].moneda, 'USD');
  });
});

test('API currency: contract currency change is rejected when financial operations exist', async () => {
  createdContracts.push({ id: 1, inmobiliariaId: 1, moneda: 'ARS', montoAlquiler: 1000 });
  createdLiquidaciones.push({ id: 1, contratoId: 1, inmobiliariaId: 1, moneda: 'ARS' });

  await withServer(async (app) => {
    const response = await request(app, '/api/contratos/1', {
      method: 'PUT',
      body: JSON.stringify({ moneda: 'USD' }),
    });

    assert.equal(response.status, 400);
    assert.match(response.body.message, /No se puede cambiar la moneda/);
  });
});
