ALTER TABLE "MovimientoCaja" ADD COLUMN "pagoSueldoId" INTEGER;

-- Los sueldos registrados antes de esta corrección también deben impactar en
-- el saldo. Cada pago histórico recibe exactamente un egreso vinculado.
INSERT INTO "MovimientoCaja" (
  "tipo",
  "concepto",
  "monto",
  "moneda",
  "fecha",
  "metodoPago",
  "cuenta",
  "observaciones",
  "fechaCreacion",
  "inmobiliariaId",
  "creadoPorId",
  "pagoSueldoId"
)
SELECT
  'EGRESO'::"TipoMovimiento",
  LEFT('Sueldo de ' || u."nombreCompleto" || ' - Período ' || ps."periodo", 255),
  ps."monto",
  ps."moneda",
  ps."fecha",
  ps."metodoPago",
  CASE
    WHEN ps."metodoPago" = 'EFECTIVO' THEN 'CAJA'::"CuentaCaja"
    ELSE 'BANCO'::"CuentaCaja"
  END,
  ps."observaciones",
  ps."fechaCreacion",
  ps."inmobiliariaId",
  ps."creadoPorId",
  ps."id"
FROM "PagoSueldo" ps
JOIN "Usuario" u ON u."id" = ps."usuarioId";

CREATE UNIQUE INDEX "MovimientoCaja_pagoSueldoId_key" ON "MovimientoCaja"("pagoSueldoId");

ALTER TABLE "MovimientoCaja"
  ADD CONSTRAINT "MovimientoCaja_pagoSueldoId_fkey"
  FOREIGN KEY ("pagoSueldoId") REFERENCES "PagoSueldo"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
