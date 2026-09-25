-- Una rescisión conserva el contrato y documenta la decisión operativa.
ALTER TABLE "Contrato"
  ADD COLUMN "fechaRescision" DATE,
  ADD COLUMN "motivoRescision" TEXT,
  ADD COLUMN "rescindidoPorId" INTEGER;

CREATE INDEX "Contrato_rescindidoPorId_idx" ON "Contrato"("rescindidoPorId");

ALTER TABLE "Contrato"
  ADD CONSTRAINT "Contrato_rescindidoPorId_fkey"
  FOREIGN KEY ("rescindidoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
