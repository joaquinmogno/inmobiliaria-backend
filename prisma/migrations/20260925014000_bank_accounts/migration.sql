CREATE TABLE "CuentaBancaria" (
  "id" SERIAL NOT NULL,
  "nombre" VARCHAR(100) NOT NULL,
  "banco" VARCHAR(100) NOT NULL,
  "moneda" "Moneda" NOT NULL DEFAULT 'ARS',
  "activa" BOOLEAN NOT NULL DEFAULT true,
  "esHistorica" BOOLEAN NOT NULL DEFAULT false,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inmobiliariaId" INTEGER NOT NULL,
  CONSTRAINT "CuentaBancaria_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CuentaBancaria_inmobiliariaId_nombre_key" ON "CuentaBancaria"("inmobiliariaId", "nombre");
CREATE INDEX "CuentaBancaria_inmobiliariaId_activa_moneda_idx" ON "CuentaBancaria"("inmobiliariaId", "activa", "moneda");

ALTER TABLE "MovimientoCaja" ADD COLUMN "cuentaBancariaId" INTEGER;
CREATE INDEX "MovimientoCaja_cuentaBancariaId_idx" ON "MovimientoCaja"("cuentaBancariaId");
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_cuentaBancariaId_fkey"
  FOREIGN KEY ("cuentaBancariaId") REFERENCES "CuentaBancaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Los asientos preexistentes no se pierden: cada inmobiliaria recibe una
-- cuenta histórica por moneda y todos sus movimientos BANCO quedan ligados a ella.
INSERT INTO "CuentaBancaria" ("nombre", "banco", "moneda", "activa", "esHistorica", "inmobiliariaId")
SELECT 'Banco general (histórico) ARS', 'Histórico', 'ARS', false, true, i."id"
FROM "Inmobiliaria" i
WHERE EXISTS (SELECT 1 FROM "MovimientoCaja" m WHERE m."inmobiliariaId" = i."id" AND m."cuenta" = 'BANCO' AND m."moneda" = 'ARS');

INSERT INTO "CuentaBancaria" ("nombre", "banco", "moneda", "activa", "esHistorica", "inmobiliariaId")
SELECT 'Banco general (histórico) USD', 'Histórico', 'USD', false, true, i."id"
FROM "Inmobiliaria" i
WHERE EXISTS (SELECT 1 FROM "MovimientoCaja" m WHERE m."inmobiliariaId" = i."id" AND m."cuenta" = 'BANCO' AND m."moneda" = 'USD');

UPDATE "MovimientoCaja" m
SET "cuentaBancariaId" = b."id"
FROM "CuentaBancaria" b
WHERE m."cuenta" = 'BANCO'
  AND b."inmobiliariaId" = m."inmobiliariaId"
  AND b."moneda" = m."moneda"
  AND b."esHistorica" = true;
