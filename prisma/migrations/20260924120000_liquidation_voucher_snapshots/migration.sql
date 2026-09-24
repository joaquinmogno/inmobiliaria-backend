-- Comprobantes versionados. La fotografía JSONB contiene las partes, el
-- contrato, los importes y los movimientos tal como estaban al emitir.
CREATE TABLE "ComprobanteLiquidacion" (
  "id" SERIAL NOT NULL,
  "liquidacionId" INTEGER NOT NULL,
  "version" INTEGER NOT NULL,
  "fotografia" JSONB NOT NULL,
  "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "creadoPorId" INTEGER NOT NULL,

  CONSTRAINT "ComprobanteLiquidacion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ComprobanteLiquidacion_liquidacionId_version_key"
  ON "ComprobanteLiquidacion"("liquidacionId", "version");
CREATE INDEX "ComprobanteLiquidacion_liquidacionId_fechaEmision_idx"
  ON "ComprobanteLiquidacion"("liquidacionId", "fechaEmision");
CREATE INDEX "ComprobanteLiquidacion_creadoPorId_idx"
  ON "ComprobanteLiquidacion"("creadoPorId");

ALTER TABLE "ComprobanteLiquidacion"
  ADD CONSTRAINT "ComprobanteLiquidacion_liquidacionId_fkey"
  FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ComprobanteLiquidacion"
  ADD CONSTRAINT "ComprobanteLiquidacion_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
