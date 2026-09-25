ALTER TABLE "Pago"
  ADD COLUMN "anuladoEn" TIMESTAMP(3),
  ADD COLUMN "motivoAnulacion" TEXT,
  ADD COLUMN "anuladoPorId" INTEGER;

ALTER TABLE "MovimientoCaja"
  ADD COLUMN "anuladoEn" TIMESTAMP(3),
  ADD COLUMN "motivoAnulacion" TEXT,
  ADD COLUMN "anuladoPorId" INTEGER,
  ADD COLUMN "pagoId" INTEGER,
  ADD COLUMN "reversionDeId" INTEGER;

CREATE UNIQUE INDEX "MovimientoCaja_pagoId_key" ON "MovimientoCaja"("pagoId");
CREATE UNIQUE INDEX "MovimientoCaja_reversionDeId_key" ON "MovimientoCaja"("reversionDeId");
CREATE INDEX "Pago_inmobiliariaId_anuladoEn_idx" ON "Pago"("inmobiliariaId", "anuladoEn");
CREATE INDEX "MovimientoCaja_inmobiliariaId_anuladoEn_idx" ON "MovimientoCaja"("inmobiliariaId", "anuladoEn");

ALTER TABLE "Pago"
  ADD CONSTRAINT "Pago_anuladoPorId_fkey"
  FOREIGN KEY ("anuladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MovimientoCaja"
  ADD CONSTRAINT "MovimientoCaja_anuladoPorId_fkey"
  FOREIGN KEY ("anuladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MovimientoCaja"
  ADD CONSTRAINT "MovimientoCaja_pagoId_fkey"
  FOREIGN KEY ("pagoId") REFERENCES "Pago"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MovimientoCaja"
  ADD CONSTRAINT "MovimientoCaja_reversionDeId_fkey"
  FOREIGN KEY ("reversionDeId") REFERENCES "MovimientoCaja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Relaciona los cobros históricos con sus asientos de caja. Los ordinales
-- permiten emparejar de forma determinista aun si se registraron importes
-- idénticos el mismo día.
WITH pagos_ordenados AS (
  SELECT id, "inmobiliariaId", "contratoId", "liquidacionId", monto, "fechaPago", "metodoPago",
    ROW_NUMBER() OVER (
      PARTITION BY "inmobiliariaId", "contratoId", "liquidacionId", monto, "fechaPago", "metodoPago"
      ORDER BY id
    ) AS ordinal
  FROM "Pago"
), movimientos_ordenados AS (
  SELECT id, "inmobiliariaId", "contratoId", "liquidacionId", monto, fecha, "metodoPago",
    ROW_NUMBER() OVER (
      PARTITION BY "inmobiliariaId", "contratoId", "liquidacionId", monto, fecha, "metodoPago"
      ORDER BY id
    ) AS ordinal
  FROM "MovimientoCaja"
  WHERE tipo = 'INGRESO' AND "pagoId" IS NULL
)
UPDATE "MovimientoCaja" AS mc
SET "pagoId" = p.id
FROM pagos_ordenados p
JOIN movimientos_ordenados m
  ON m."inmobiliariaId" = p."inmobiliariaId"
 AND m."contratoId" = p."contratoId"
 AND m."liquidacionId" = p."liquidacionId"
 AND m.monto = p.monto
 AND m.fecha = p."fechaPago"
 AND m."metodoPago" = p."metodoPago"
 AND m.ordinal = p.ordinal
WHERE mc.id = m.id;
