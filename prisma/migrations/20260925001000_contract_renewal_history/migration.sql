-- B-35: a renewal is a new contract, explicitly linked to its predecessor.
ALTER TABLE "Contrato"
  ADD COLUMN "contratoAnteriorId" INTEGER;

CREATE UNIQUE INDEX "Contrato_contratoAnteriorId_key" ON "Contrato"("contratoAnteriorId");
CREATE INDEX "Contrato_inmobiliariaId_contratoAnteriorId_idx" ON "Contrato"("inmobiliariaId", "contratoAnteriorId");

ALTER TABLE "Contrato"
  ADD CONSTRAINT "Contrato_contratoAnteriorId_fkey"
  FOREIGN KEY ("contratoAnteriorId") REFERENCES "Contrato"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
