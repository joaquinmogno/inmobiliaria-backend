-- Cada transición de cierre queda registrada de forma inmutable. La fila
-- principal conserva únicamente el estado vigente del período.
ALTER TABLE "CierreCaja"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- Una fila que ya estaba reabierta contiene dos transiciones históricas: su
-- cierre original y la reapertura registrada en las columnas existentes.
UPDATE "CierreCaja"
SET "version" = 2
WHERE "estado" = 'REABIERTO';

CREATE TYPE "TipoEventoCierreCaja" AS ENUM ('CIERRE', 'REAPERTURA');

CREATE TABLE "EventoCierreCaja" (
  "id" SERIAL NOT NULL,
  "tipo" "TipoEventoCierreCaja" NOT NULL,
  "version" INTEGER NOT NULL,
  "saldoSistema" DECIMAL(10,2) NOT NULL,
  "saldoDeclarado" DECIMAL(10,2) NOT NULL,
  "diferencia" DECIMAL(10,2) NOT NULL,
  "motivo" TEXT,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "cierreCajaId" INTEGER NOT NULL,
  "usuarioId" INTEGER NOT NULL,

  CONSTRAINT "EventoCierreCaja_pkey" PRIMARY KEY ("id")
);

-- Los cierres existentes pasan a tener su primer evento histórico. El usuario
-- y los saldos se toman de la conciliación que ya estaba almacenada.
INSERT INTO "EventoCierreCaja" (
  "tipo", "version", "saldoSistema", "saldoDeclarado", "diferencia", "motivo",
  "fechaCreacion", "cierreCajaId", "usuarioId"
)
SELECT
  'CIERRE'::"TipoEventoCierreCaja", 1, "saldoSistema", "saldoDeclarado", "diferencia", "motivoDiferencia",
  "cerradoEn", "id", "cerradoPorId"
FROM "CierreCaja";

INSERT INTO "EventoCierreCaja" (
  "tipo", "version", "saldoSistema", "saldoDeclarado", "diferencia", "motivo",
  "fechaCreacion", "cierreCajaId", "usuarioId"
)
SELECT
  'REAPERTURA'::"TipoEventoCierreCaja", 2, "saldoSistema", "saldoDeclarado", "diferencia", "motivoReapertura",
  COALESCE("reabiertoEn", "cerradoEn"), "id", COALESCE("reabiertoPorId", "cerradoPorId")
FROM "CierreCaja"
WHERE "estado" = 'REABIERTO';

CREATE UNIQUE INDEX "EventoCierreCaja_cierreCajaId_version_key"
  ON "EventoCierreCaja"("cierreCajaId", "version");
CREATE INDEX "EventoCierreCaja_cierreCajaId_fechaCreacion_idx"
  ON "EventoCierreCaja"("cierreCajaId", "fechaCreacion");
CREATE INDEX "EventoCierreCaja_usuarioId_idx"
  ON "EventoCierreCaja"("usuarioId");

ALTER TABLE "EventoCierreCaja"
  ADD CONSTRAINT "EventoCierreCaja_cierreCajaId_fkey"
  FOREIGN KEY ("cierreCajaId") REFERENCES "CierreCaja"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventoCierreCaja"
  ADD CONSTRAINT "EventoCierreCaja_usuarioId_fkey"
  FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
