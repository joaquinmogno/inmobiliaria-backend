-- Espacio mensual de liquidaciones: snapshots históricos, confirmación
-- atribuible y decisiones explícitas sobre excepciones del período.
ALTER TABLE "Liquidacion"
  ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "fechaConfirmacion" TIMESTAMP(3),
  ADD COLUMN "confirmadoPorId" INTEGER,
  ADD COLUMN "propiedadDireccion" TEXT,
  ADD COLUMN "inquilinoNombre" TEXT,
  ADD COLUMN "propietarioNombre" TEXT;

-- El destinatario de pagos ya identificados sí es un dato histórico confiable.
UPDATE "Liquidacion" l
SET "propietarioNombre" = p."nombreCompleto"
FROM "Persona" p
WHERE p.id = l."propietarioPagoId";

CREATE INDEX "Liquidacion_confirmadoPorId_idx" ON "Liquidacion"("confirmadoPorId");
ALTER TABLE "Liquidacion"
  ADD CONSTRAINT "Liquidacion_confirmadoPorId_fkey"
  FOREIGN KEY ("confirmadoPorId") REFERENCES "Usuario"(id) ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "DecisionLiquidacionMensual" (
  "id" SERIAL NOT NULL,
  "periodo" DATE NOT NULL,
  "motivo" VARCHAR(500) NOT NULL,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inmobiliariaId" INTEGER NOT NULL,
  "contratoId" INTEGER NOT NULL,
  "usuarioId" INTEGER,
  CONSTRAINT "DecisionLiquidacionMensual_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DecisionLiquidacionMensual_contratoId_periodo_key"
  ON "DecisionLiquidacionMensual"("contratoId", "periodo");
CREATE INDEX "DecisionLiquidacionMensual_inmobiliariaId_periodo_idx"
  ON "DecisionLiquidacionMensual"("inmobiliariaId", "periodo");

ALTER TABLE "DecisionLiquidacionMensual"
  ADD CONSTRAINT "DecisionLiquidacionMensual_inmobiliariaId_fkey"
    FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DecisionLiquidacionMensual_contratoId_fkey"
    FOREIGN KEY ("contratoId") REFERENCES "Contrato"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "DecisionLiquidacionMensual_usuarioId_fkey"
    FOREIGN KEY ("usuarioId") REFERENCES "Usuario"(id) ON DELETE SET NULL ON UPDATE CASCADE;
