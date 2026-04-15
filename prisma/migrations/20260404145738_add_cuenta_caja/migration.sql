/*
  Warnings:

  - The values [PAGADA,PAGADA_A_PROPIETARIO] on the enum `EstadoLiquidacion` will be removed. If these variants are still used in the database, this will fail.

*/
-- CreateEnum
CREATE TYPE "CuentaCaja" AS ENUM ('CAJA', 'BANCO');

-- AlterEnum
BEGIN;
CREATE TYPE "EstadoLiquidacion_new" AS ENUM ('BORRADOR', 'PENDIENTE_PAGO', 'PAGADA_POR_INQUILINO', 'LIQUIDADA');
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" DROP DEFAULT;
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" TYPE "EstadoLiquidacion_new" USING ("estado"::text::"EstadoLiquidacion_new");
ALTER TYPE "EstadoLiquidacion" RENAME TO "EstadoLiquidacion_old";
ALTER TYPE "EstadoLiquidacion_new" RENAME TO "EstadoLiquidacion";
DROP TYPE "EstadoLiquidacion_old";
ALTER TABLE "Liquidacion" ALTER COLUMN "estado" SET DEFAULT 'BORRADOR';
COMMIT;

-- AlterEnum
ALTER TYPE "RolUsuario" ADD VALUE 'SUPERADMIN';

-- AlterTable
ALTER TABLE "Inmobiliaria" ADD COLUMN     "activa" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "MovimientoCaja" ADD COLUMN     "cuenta" "CuentaCaja" NOT NULL DEFAULT 'CAJA';

-- CreateTable
CREATE TABLE "ActualizacionContrato" (
    "id" SERIAL NOT NULL,
    "fechaActualizacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "montoAnterior" DECIMAL(10,2) NOT NULL,
    "montoNuevo" DECIMAL(10,2) NOT NULL,
    "fechaProximaAnterior" DATE,
    "fechaProximaNueva" DATE NOT NULL,
    "observaciones" TEXT,
    "usuarioId" INTEGER,
    "contratoId" INTEGER NOT NULL,

    CONSTRAINT "ActualizacionContrato_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActualizacionContrato_contratoId_idx" ON "ActualizacionContrato"("contratoId");

-- CreateIndex
CREATE INDEX "ActualizacionContrato_fechaActualizacion_idx" ON "ActualizacionContrato"("fechaActualizacion");

-- CreateIndex
CREATE INDEX "MovimientoCaja_cuenta_idx" ON "MovimientoCaja"("cuenta");

-- AddForeignKey
ALTER TABLE "ActualizacionContrato" ADD CONSTRAINT "ActualizacionContrato_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActualizacionContrato" ADD CONSTRAINT "ActualizacionContrato_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE CASCADE ON UPDATE CASCADE;
