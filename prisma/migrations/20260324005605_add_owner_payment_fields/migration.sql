-- AlterEnum
ALTER TYPE "EstadoLiquidacion" ADD VALUE 'PAGADA_A_PROPIETARIO';

-- AlterTable
ALTER TABLE "Liquidacion" ADD COLUMN     "fechaPagoPropietario" DATE,
ADD COLUMN     "metodoPagoPropietario" "MetodoPago";

-- AlterTable
ALTER TABLE "MovimientoCaja" ADD COLUMN     "liquidacionId" INTEGER;

-- AddForeignKey
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
