-- AlterTable
ALTER TABLE "Movimiento" ADD COLUMN     "esParaInmobiliaria" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "PlanCuotas" ADD COLUMN     "esParaInmobiliaria" BOOLEAN NOT NULL DEFAULT false;
