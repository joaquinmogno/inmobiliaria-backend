-- Los planes y sus cuotas son documentos históricos: no se eliminan al
-- cancelarlos, condonarlos o reprogramarlos.
ALTER TYPE "EstadoPlanCuotas" RENAME TO "EstadoPlanCuotas_old";
CREATE TYPE "EstadoPlanCuotas" AS ENUM ('VIGENTE', 'CUMPLIDO', 'CANCELADO', 'REPROGRAMADO', 'CONDONADO');
ALTER TABLE "PlanCuotas"
  ALTER COLUMN "estado" DROP DEFAULT,
  ALTER COLUMN "estado" TYPE "EstadoPlanCuotas" USING (
    CASE "estado"::text
      WHEN 'ACTIVO' THEN 'VIGENTE'::"EstadoPlanCuotas"
      WHEN 'FINALIZADO' THEN 'CUMPLIDO'::"EstadoPlanCuotas"
      WHEN 'CANCELADO' THEN 'CANCELADO'::"EstadoPlanCuotas"
    END
  ),
  ALTER COLUMN "estado" SET DEFAULT 'VIGENTE';
DROP TYPE "EstadoPlanCuotas_old";

ALTER TYPE "EstadoCuota" RENAME TO "EstadoCuota_old";
CREATE TYPE "EstadoCuota" AS ENUM ('PENDIENTE', 'PAGADA', 'CANCELADA', 'REPROGRAMADA', 'CONDONADA');
ALTER TABLE "CuotaPlan"
  ALTER COLUMN "estado" DROP DEFAULT,
  ALTER COLUMN "estado" TYPE "EstadoCuota" USING "estado"::text::"EstadoCuota",
  ALTER COLUMN "estado" SET DEFAULT 'PENDIENTE';
DROP TYPE "EstadoCuota_old";

ALTER TABLE "PlanCuotas"
  ADD COLUMN "fechaCierre" TIMESTAMP(3),
  ADD COLUMN "motivoCierre" TEXT,
  ADD COLUMN "planOrigenId" INTEGER,
  ADD COLUMN "cerradoPorId" INTEGER;

CREATE INDEX "PlanCuotas_planOrigenId_idx" ON "PlanCuotas"("planOrigenId");
CREATE INDEX "PlanCuotas_cerradoPorId_idx" ON "PlanCuotas"("cerradoPorId");

ALTER TABLE "PlanCuotas"
  ADD CONSTRAINT "PlanCuotas_planOrigenId_fkey"
  FOREIGN KEY ("planOrigenId") REFERENCES "PlanCuotas"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PlanCuotas"
  ADD CONSTRAINT "PlanCuotas_cerradoPorId_fkey"
  FOREIGN KEY ("cerradoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
