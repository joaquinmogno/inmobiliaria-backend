ALTER TABLE "Contrato"
ADD COLUMN "notaInterna" TEXT,
ADD COLUMN "notaInternaVersion" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "notaInternaActualizadaEn" TIMESTAMP(3),
ADD COLUMN "notaInternaActualizadaPorId" INTEGER;

CREATE INDEX "Contrato_notaInternaActualizadaPorId_idx" ON "Contrato"("notaInternaActualizadaPorId");

ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_notaInternaActualizadaPorId_fkey"
FOREIGN KEY ("notaInternaActualizadaPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
