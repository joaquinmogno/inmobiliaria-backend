ALTER TABLE "Contrato"
    ALTER COLUMN "pagaHonorarios" SET DEFAULT 'PROPIETARIO';

ALTER TABLE "Liquidacion"
    ALTER COLUMN "pagaHonorarios" SET DEFAULT 'PROPIETARIO',
    ADD COLUMN "alquilerExcepcional" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "motivoCambioAlquiler" TEXT;

ALTER TABLE "ActualizacionContrato"
    ADD COLUMN "fechaVigencia" DATE,
    ADD COLUMN "porcentajeAplicado" DECIMAL(8,4);

CREATE INDEX "ActualizacionContrato_contratoId_fechaVigencia_idx"
    ON "ActualizacionContrato"("contratoId", "fechaVigencia");
