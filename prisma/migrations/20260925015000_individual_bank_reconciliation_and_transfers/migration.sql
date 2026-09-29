-- Las cuentas históricas se crean también para inmobiliarias sin movimientos
-- bancarios previos: permiten conservar cierres genéricos de saldo cero y
-- evitan que un asiento legado quede sin una cuenta identificable.
INSERT INTO "CuentaBancaria" ("nombre", "banco", "moneda", "activa", "esHistorica", "inmobiliariaId")
SELECT
  'Banco general (histórico) ' || currencies."moneda"::text,
  'Histórico',
  currencies."moneda",
  false,
  true,
  agencies."id"
FROM "Inmobiliaria" agencies
CROSS JOIN (VALUES ('ARS'::"Moneda"), ('USD'::"Moneda")) AS currencies("moneda")
WHERE NOT EXISTS (
  SELECT 1
  FROM "CuentaBancaria" account
  WHERE account."inmobiliariaId" = agencies."id"
    AND account."nombre" = 'Banco general (histórico) ' || currencies."moneda"::text
);

-- Es idempotente frente a la primera migración de cuentas: sólo completa las
-- filas bancarias que aún no fueron asociadas a su cuenta histórica.
UPDATE "MovimientoCaja" movement
SET "cuentaBancariaId" = historical."id"
FROM "CuentaBancaria" historical
WHERE movement."cuenta" = 'BANCO'
  AND movement."cuentaBancariaId" IS NULL
  AND historical."inmobiliariaId" = movement."inmobiliariaId"
  AND historical."moneda" = movement."moneda"
  AND historical."esHistorica" = true;

ALTER TABLE "CierreCaja" ADD COLUMN "cuentaBancariaId" INTEGER;
ALTER TABLE "CierreCaja" ADD CONSTRAINT "CierreCaja_cuentaBancariaId_fkey"
  FOREIGN KEY ("cuentaBancariaId") REFERENCES "CuentaBancaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Los cierres bancarios previos representan el banco consolidado. Se conservan
-- con cuenta nula y siguen bloqueando ese período como cierre legado; los
-- cierres creados a partir de ahora llevan una cuenta concreta.
DROP INDEX IF EXISTS "CierreCaja_inmobiliariaId_periodo_cuenta_moneda_key";
CREATE INDEX "CierreCaja_inmobiliariaId_periodo_cuenta_moneda_cuentaBancariaId_idx"
  ON "CierreCaja"("inmobiliariaId", "periodo", "cuenta", "moneda", "cuentaBancariaId");
CREATE INDEX "CierreCaja_cuentaBancariaId_idx" ON "CierreCaja"("cuentaBancariaId");
CREATE UNIQUE INDEX "CierreCaja_caja_periodo_moneda_key"
  ON "CierreCaja"("inmobiliariaId", "periodo", "moneda")
  WHERE "cuenta" = 'CAJA' AND "cuentaBancariaId" IS NULL;
CREATE UNIQUE INDEX "CierreCaja_banco_periodo_cuenta_key"
  ON "CierreCaja"("inmobiliariaId", "periodo", "cuentaBancariaId")
  WHERE "cuenta" = 'BANCO' AND "cuentaBancariaId" IS NOT NULL;

CREATE TABLE "TransferenciaInterna" (
  "id" SERIAL NOT NULL,
  "fecha" DATE NOT NULL,
  "monto" DECIMAL(10,2) NOT NULL,
  "moneda" "Moneda" NOT NULL,
  "concepto" VARCHAR(255) NOT NULL,
  "observaciones" TEXT,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inmobiliariaId" INTEGER NOT NULL,
  "creadoPorId" INTEGER,
  CONSTRAINT "TransferenciaInterna_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TransferenciaInterna_inmobiliariaId_fecha_idx"
  ON "TransferenciaInterna"("inmobiliariaId", "fecha");
ALTER TABLE "TransferenciaInterna" ADD CONSTRAINT "TransferenciaInterna_inmobiliariaId_fkey"
  FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TransferenciaInterna" ADD CONSTRAINT "TransferenciaInterna_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "MovimientoCaja" ADD COLUMN "transferenciaInternaId" INTEGER;
CREATE INDEX "MovimientoCaja_transferenciaInternaId_idx" ON "MovimientoCaja"("transferenciaInternaId");
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_transferenciaInternaId_fkey"
  FOREIGN KEY ("transferenciaInternaId") REFERENCES "TransferenciaInterna"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
