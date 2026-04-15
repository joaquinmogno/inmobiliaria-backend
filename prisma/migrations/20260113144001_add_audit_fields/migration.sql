-- AlterTable
ALTER TABLE "Contrato" ADD COLUMN     "actualizadoPorId" INTEGER,
ADD COLUMN     "creadoPorId" INTEGER;

-- AlterTable
ALTER TABLE "Inquilino" ADD COLUMN     "actualizadoPorId" INTEGER,
ADD COLUMN     "creadoPorId" INTEGER;

-- AlterTable
ALTER TABLE "Propiedad" ADD COLUMN     "actualizadoPorId" INTEGER,
ADD COLUMN     "creadoPorId" INTEGER;

-- AlterTable
ALTER TABLE "Propietario" ADD COLUMN     "actualizadoPorId" INTEGER,
ADD COLUMN     "creadoPorId" INTEGER;

-- AddForeignKey
ALTER TABLE "Propietario" ADD CONSTRAINT "Propietario_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Propietario" ADD CONSTRAINT "Propietario_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquilino" ADD CONSTRAINT "Inquilino_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquilino" ADD CONSTRAINT "Inquilino_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Propiedad" ADD CONSTRAINT "Propiedad_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Propiedad" ADD CONSTRAINT "Propiedad_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
