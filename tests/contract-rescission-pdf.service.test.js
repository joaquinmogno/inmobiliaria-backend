const test = require('node:test');
const assert = require('node:assert/strict');
const { rescissionActWording } = require('../dist/services/contract-rescission-pdf.service');

const snapshot = {
  contrato: {
    id: 8, direccion: 'Arregui 1234', piso: '3', departamento: 'B',
    fechaInicio: '2026-01-01', fechaFin: '2027-12-31',
    propietarios: [{ nombre: 'Propietaria de prueba', dni: '12345678' }],
    inquilinos: [{ nombre: 'Inquilino de prueba', dni: '87654321' }]
  },
  declaracion: {
    tipoCierre: 'ANTICIPADA_INQUILINO', fechaRescision: '2026-10-01', motivo: 'Decisión del inquilino', llavesEntregadas: true,
    fechaEntregaLlaves: '2026-10-01', cantidadLlaves: 2, estadoInmueble: 'Desocupado'
  }
};

test('el cierre anticipado identifica a las partes y documenta la declaración sin reclamos', () => {
  const wording = rescissionActWording(snapshot);
  assert.match(wording.title, /RESCISIÓN ANTICIPADA VOLUNTARIA/);
  assert.match(wording.introduction, /Arregui 1234, piso 3, departamento B/);
  assert.match(wording.introduction, /Propietaria de prueba, DNI N.º 12345678/);
  assert.match(wording.introduction, /Inquilino de prueba, DNI N.º 87654321/);
  assert.match(wording.delivery, /acta de llaves/);
  assert.match(wording.financial, /declaran haber revisado y resuelto/);
  assert.match(wording.closing, /nada tienen que reclamarse a futuro/);
});

test('el cierre por vencimiento usa un título distinto de la rescisión anticipada', () => {
  const wording = rescissionActWording({
    ...snapshot,
    declaracion: { ...snapshot.declaracion, tipoCierre: 'VENCIMIENTO_ACORDADO' }
  });
  assert.match(wording.title, /FINALIZACIÓN DE CONTRATO/);
  assert.doesNotMatch(wording.title, /ANTICIPADA/);
});
