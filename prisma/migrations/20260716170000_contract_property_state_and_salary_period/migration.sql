ALTER TABLE "Contrato" ADD COLUMN "estadoAnteriorPapelera" "EstadoContrato";

UPDATE "PagoSueldo"
SET "periodo" = substring("periodo" from 4 for 4) || '-' || substring("periodo" from 1 for 2)
WHERE "periodo" ~ '^(0[1-9]|1[0-2])-[0-9]{4}$';

CREATE UNIQUE INDEX "PagoSueldo_inmobiliariaId_usuarioId_periodo_moneda_key"
ON "PagoSueldo"("inmobiliariaId", "usuarioId", "periodo", "moneda");
