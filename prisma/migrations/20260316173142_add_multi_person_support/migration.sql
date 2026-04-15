/*
  Warnings:

  - You are about to drop the column `inquilinoId` on the `Contrato` table. All the data in the column will be lost.
  - You are about to drop the column `propietarioId` on the `Contrato` table. All the data in the column will be lost.

*/
-- DropForeignKey
ALTER TABLE "Contrato" DROP CONSTRAINT "Contrato_inquilinoId_fkey";

-- DropForeignKey
ALTER TABLE "Contrato" DROP CONSTRAINT "Contrato_propietarioId_fkey";

-- DropIndex
DROP INDEX "Contrato_inquilinoId_idx";

-- DropIndex
DROP INDEX "Contrato_propietarioId_idx";

-- AlterTable
ALTER TABLE "Contrato" DROP COLUMN "inquilinoId",
DROP COLUMN "propietarioId";

-- CreateTable
CREATE TABLE "ContratoInquilino" (
    "id" SERIAL NOT NULL,
    "contratoId" INTEGER NOT NULL,
    "personaId" INTEGER NOT NULL,
    "esPrincipal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContratoInquilino_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContratoPropietario" (
    "id" SERIAL NOT NULL,
    "contratoId" INTEGER NOT NULL,
    "personaId" INTEGER NOT NULL,
    "esPrincipal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ContratoPropietario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContratoInquilino_contratoId_idx" ON "ContratoInquilino"("contratoId");

-- CreateIndex
CREATE INDEX "ContratoInquilino_personaId_idx" ON "ContratoInquilino"("personaId");

-- CreateIndex
CREATE INDEX "ContratoPropietario_contratoId_idx" ON "ContratoPropietario"("contratoId");

-- CreateIndex
CREATE INDEX "ContratoPropietario_personaId_idx" ON "ContratoPropietario"("personaId");

-- AddForeignKey
ALTER TABLE "ContratoInquilino" ADD CONSTRAINT "ContratoInquilino_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContratoInquilino" ADD CONSTRAINT "ContratoInquilino_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContratoPropietario" ADD CONSTRAINT "ContratoPropietario_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContratoPropietario" ADD CONSTRAINT "ContratoPropietario_personaId_fkey" FOREIGN KEY ("personaId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
