-- CreateEnum
CREATE TYPE "PagadorHonorarios" AS ENUM ('INQUILINO', 'PROPIETARIO');

-- AlterEnum
ALTER TYPE "EstadoContrato" ADD VALUE 'RESCINDIDO';

-- AlterTable
ALTER TABLE "Contrato" ADD COLUMN     "pagaHonorarios" "PagadorHonorarios" NOT NULL DEFAULT 'INQUILINO',
ADD COLUMN     "porcentajeHonorarios" DECIMAL(5,2);
