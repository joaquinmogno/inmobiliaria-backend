ALTER TABLE "Contrato" ADD COLUMN "frecuenciaActualizacionMeses" INTEGER;
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_frecuenciaActualizacionMeses_check"
  CHECK ("frecuenciaActualizacionMeses" IS NULL OR "frecuenciaActualizacionMeses" BETWEEN 1 AND 120);
