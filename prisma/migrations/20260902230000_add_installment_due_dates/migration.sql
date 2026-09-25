ALTER TABLE "CuotaPlan"
ADD COLUMN "fechaVencimiento" DATE;

UPDATE "CuotaPlan" AS cuota
SET "fechaVencimiento" = (
  date_trunc('month', plan."fechaCreacion")
  + ((cuota."numeroCuota" - 1) * INTERVAL '1 month')
)::date
FROM "PlanCuotas" AS plan
WHERE plan."id" = cuota."planId";

ALTER TABLE "CuotaPlan"
ALTER COLUMN "fechaVencimiento" SET NOT NULL;

CREATE INDEX "CuotaPlan_fechaVencimiento_estado_idx"
ON "CuotaPlan"("fechaVencimiento", "estado");
