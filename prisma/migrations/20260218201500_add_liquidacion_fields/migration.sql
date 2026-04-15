-- CreateEnum
CREATE TYPE "TipoMovimiento" AS ENUM ('INGRESO', 'DESCUENTO');

-- AlterEnum
BEGIN;
CREATE TYPE "EstadoLiquidacion_new" AS ENUM ('BORRADOR', 'LIQUIDADA', 'PAGADA');
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" DROP DEFAULT;
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" TYPE "EstadoLiquidacion_new" USING ("estado"::text::"EstadoLiquidacion_new");
ALTER TYPE "EstadoLiquidacion" RENAME TO "EstadoLiquidacion_old";
ALTER TYPE "EstadoLiquidacion_new" RENAME TO "EstadoLiquidacion";
DROP TYPE "EstadoLiquidacion_old";
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" SET DEFAULT 'BORRADOR';
COMMIT;

-- AlterTable
ALTER TABLE "Liquidacion" DROP COLUMN "deudaAnterior",
DROP COLUMN "fechaCierre",
DROP COLUMN "montoAlquiler",
DROP COLUMN "montoExpensas",
DROP COLUMN "montoHonorarios",
DROP COLUMN "montoNetoPropietario",
DROP COLUMN "montoOtrosGastos",
DROP COLUMN "montoTotal",
ADD COLUMN     "fechaLiquidacion" TIMESTAMP(3),
ADD COLUMN     "netoACobrar" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalDescuentos" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "totalIngresos" DECIMAL(10,2) NOT NULL DEFAULT 0,
ALTER COLUMN "estado" SET DEFAULT 'BORRADOR';

-- CreateTable
CREATE TABLE "Movimiento" (
    "id" SERIAL NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "concepto" TEXT NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "observaciones" TEXT,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "liquidacionId" INTEGER NOT NULL,

    CONSTRAINT "Movimiento_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Movimiento_liquidacionId_idx" ON "Movimiento"("liquidacionId");

-- AddForeignKey
ALTER TABLE "Movimiento" ADD CONSTRAINT "Movimiento_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
