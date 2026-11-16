const { receiptFinancialContext } = require('../../dist/services/movement-receipt.service');
const base = {
    formato: 1,
    emisor: { nombre: 'Inmobiliaria del Parque', cuit: null, direccion: 'Av. del Parque 1532 · Buenos Aires', contacto: 'contacto@example.com · Datos de demostración', logo: null },
    movimiento: { id: 21, ambito: 'CAJA', tipo: 'EGRESO', fecha: '2026-11-15', concepto: 'Reparación de instalación sanitaria', monto: '150000.00', moneda: 'ARS', metodoPago: 'TRANSFERENCIA' },
    datos: { pagador: 'Inmobiliaria del Parque', receptor: 'José Martín Pérez', documentoReceptor: '30.123.456', inmueble: 'Av. del Parque 1532 · Piso 3, unidad B', descripcion: 'Reparación de la instalación sanitaria: reemplazo de grifería y conexiones, materiales y mano de obra.' }
};
const identity = { numero: 'REC-000021', version: 1, fechaEmision: new Date('2026-11-16T15:42:00Z'), estado: 'VIGENTE' };
const liquidation = {
    id: 18, contratoId: 7, periodo: new Date('2026-11-01'), moneda: 'USD', montoHonorarios: '0',
    netoACobrar: '100.00', montoPropietario: '100.00',
    movimientos: [{ tipo: 'INGRESO', monto: '100.00', moneda: 'USD', esParaInmobiliaria: false }, { tipo: 'INGRESO', monto: '105000.00', moneda: 'ARS', esParaInmobiliaria: false }, { tipo: 'INGRESO', monto: '10000.00', moneda: 'ARS', esParaInmobiliaria: true }],
    pagos: [{ monto: '50000.25', moneda: 'ARS' }, { monto: '100.00', moneda: 'USD' }],
    pagosPropietario: [{ monto: '50000.00', moneda: 'ARS' }], aplicacionesCredito: []
};
const context = operacion => receiptFinancialContext(liquidation, operacion, identity.fechaEmision);
const examples = [
    { name: '01-recibo-institucional', snapshot: base, identity },
    { name: '02-vista-previa', snapshot: base, identity: { ...identity, numero: 'SIN EMITIR', estado: 'BORRADOR' } },
    { name: '03-cobro-parcial-ARS-USD', snapshot: { ...base, movimiento: { ...base.movimiento, tipo: 'INGRESO', monto: '50000.25', concepto: 'Cobro parcial de alquiler' }, datos: { ...base.datos, pagador: 'María Fernanda Fernández', receptor: base.emisor.nombre, documentoReceptor: '', descripcion: 'Cobro parcial correspondiente a la liquidación de noviembre. El importe de este recibo está expresado en pesos; los saldos en dólares se informan por separado.' }, contexto: context('COBRO_INQUILINO') }, identity },
    { name: '04-pago-parcial-propietario', snapshot: { ...base, movimiento: { ...base.movimiento, monto: '50000.00', concepto: 'Pago parcial al propietario' }, datos: { ...base.datos, receptor: 'Roberto Alejandro García', descripcion: 'Entrega parcial al propietario por la liquidación de noviembre de 2026.' }, contexto: context('PAGO_PROPIETARIO') }, identity },
    { name: '05-recibo-USD', snapshot: { ...base, movimiento: { ...base.movimiento, moneda: 'USD', monto: '1000.50' } }, identity },
    { name: '06-textos-extensos', snapshot: { ...base, movimiento: { ...base.movimiento, monto: '50000.00' },
        emisor: { ...base.emisor, nombre: 'Administración Inmobiliaria del Parque y Asociados · Departamento de locaciones y gestión de inmuebles' },
        datos: { ...base.datos, pagador: 'Administración y Representación de Propietarios del Parque Sociedad de Responsabilidad Limitada · Departamento de Servicios y Mantenimiento de Inmuebles'.slice(0,180), receptor: 'Cooperativa de Trabajo de Instaladores Sanitarios y Servicios Integrales de Mantenimiento de la Ciudad de Buenos Aires · Representante José María Fernández'.slice(0,180), inmueble: 'Avenida del Parque 1532, edificio de oficinas y viviendas, tercer piso, departamento B, entrada por pasillo lateral, Ciudad Autónoma de Buenos Aires.', descripcion: Array.from({length: 32},(_,i)=>`Tarea ${String(i+1).padStart(2,'0')}: reparación y control de conexiones.`).join('\n').slice(0,1500) }, contexto: context('PAGO_PROPIETARIO') }, identity: { ...identity, version: 3, estado: 'ANULADO' } },
    { name: '07-vista-previa-varias-paginas', snapshot: { ...base, datos: { ...base.datos, descripcion: 'Detalle de material y mano de obra.\n'.repeat(40).trim() } }, identity: { ...identity, numero: 'SIN EMITIR', estado: 'BORRADOR' } }
];
module.exports = { base, identity, liquidation, examples };
