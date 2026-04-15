-- AlterTable
ALTER TABLE "Contrato" ADD COLUMN     "tipoAjuste" TEXT;

-- AlterTable
ALTER TABLE "Liquidacion" ADD COLUMN     "montoHonorarios" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "porcentajeHonorarios" DECIMAL(5,2);
