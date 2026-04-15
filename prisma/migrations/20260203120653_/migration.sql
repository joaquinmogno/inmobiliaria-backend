/*
  Warnings:

  - You are about to drop the column `propietarioId` on the `Propiedad` table. All the data in the column will be lost.
  - You are about to drop the `Inquilino` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Propietario` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `montoAlquiler` to the `Contrato` table without a default value. This is not possible if the table is not empty.
  - Added the required column `montoHonorarios` to the `Contrato` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "EstadoLiquidacion" AS ENUM ('ABIERTA', 'CERRADA');

-- CreateEnum
CREATE TYPE "MetodoPago" AS ENUM ('EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTROS');

-- CreateEnum
CREATE TYPE "EstadoPersona" AS ENUM ('ACTIVO', 'INACTIVO');

-- DropForeignKey
ALTER TABLE "Contrato" DROP CONSTRAINT "Contrato_inquilinoId_fkey";

-- DropForeignKey
ALTER TABLE "Contrato" DROP CONSTRAINT "Contrato_propietarioId_fkey";

-- DropForeignKey
ALTER TABLE "Inquilino" DROP CONSTRAINT "Inquilino_actualizadoPorId_fkey";

-- DropForeignKey
ALTER TABLE "Inquilino" DROP CONSTRAINT "Inquilino_creadoPorId_fkey";

-- DropForeignKey
ALTER TABLE "Inquilino" DROP CONSTRAINT "Inquilino_inmobiliariaId_fkey";

-- DropForeignKey
ALTER TABLE "Propiedad" DROP CONSTRAINT "Propiedad_propietarioId_fkey";

-- DropForeignKey
ALTER TABLE "Propietario" DROP CONSTRAINT "Propietario_actualizadoPorId_fkey";

-- DropForeignKey
ALTER TABLE "Propietario" DROP CONSTRAINT "Propietario_creadoPorId_fkey";

-- DropForeignKey
ALTER TABLE "Propietario" DROP CONSTRAINT "Propietario_inmobiliariaId_fkey";

-- AlterTable
ALTER TABLE "Contrato" ADD COLUMN     "diaVencimiento" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "garanteId" INTEGER,
ADD COLUMN     "montoAlquiler" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "montoHonorarios" DECIMAL(10,2) NOT NULL,
ADD COLUMN     "porcentajeActualizacion" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "Propiedad" DROP COLUMN "propietarioId";

-- DropTable
DROP TABLE "Inquilino";

-- DropTable
DROP TABLE "Propietario";

-- CreateTable
CREATE TABLE "Persona" (
    "id" SERIAL NOT NULL,
    "nombreCompleto" TEXT NOT NULL,
    "dni" TEXT,
    "telefono" TEXT,
    "email" TEXT,
    "direccion" TEXT,
    "estado" "EstadoPersona" NOT NULL DEFAULT 'ACTIVO',
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaActualizacion" TIMESTAMP(3) NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER,
    "actualizadoPorId" INTEGER,

    CONSTRAINT "Persona_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Liquidacion" (
    "id" SERIAL NOT NULL,
    "periodo" DATE NOT NULL,
    "estado" "EstadoLiquidacion" NOT NULL DEFAULT 'ABIERTA',
    "montoAlquiler" DECIMAL(10,2) NOT NULL,
    "montoHonorarios" DECIMAL(10,2) NOT NULL,
    "montoExpensas" DECIMAL(10,2),
    "montoOtrosGastos" DECIMAL(10,2),
    "montoTotal" DECIMAL(10,2) NOT NULL,
    "montoNetoPropietario" DECIMAL(10,2) NOT NULL,
    "deudaAnterior" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaCierre" TIMESTAMP(3),
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER,
    "cerradoPorId" INTEGER,
    "contratoId" INTEGER NOT NULL,

    CONSTRAINT "Liquidacion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pago" (
    "id" SERIAL NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "fechaPago" DATE NOT NULL,
    "metodoPago" "MetodoPago" NOT NULL DEFAULT 'EFECTIVO',
    "comprobante" TEXT,
    "observaciones" TEXT,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER,
    "contratoId" INTEGER NOT NULL,
    "liquidacionId" INTEGER NOT NULL,

    CONSTRAINT "Pago_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Persona_inmobiliariaId_idx" ON "Persona"("inmobiliariaId");

-- CreateIndex
CREATE INDEX "Persona_dni_idx" ON "Persona"("dni");

-- CreateIndex
CREATE INDEX "Liquidacion_inmobiliariaId_idx" ON "Liquidacion"("inmobiliariaId");

-- CreateIndex
CREATE INDEX "Liquidacion_contratoId_idx" ON "Liquidacion"("contratoId");

-- CreateIndex
CREATE INDEX "Liquidacion_periodo_idx" ON "Liquidacion"("periodo");

-- CreateIndex
CREATE INDEX "Liquidacion_estado_idx" ON "Liquidacion"("estado");

-- CreateIndex
CREATE UNIQUE INDEX "Liquidacion_contratoId_periodo_key" ON "Liquidacion"("contratoId", "periodo");

-- CreateIndex
CREATE INDEX "Pago_inmobiliariaId_idx" ON "Pago"("inmobiliariaId");

-- CreateIndex
CREATE INDEX "Pago_contratoId_idx" ON "Pago"("contratoId");

-- CreateIndex
CREATE INDEX "Pago_liquidacionId_idx" ON "Pago"("liquidacionId");

-- CreateIndex
CREATE INDEX "Pago_fechaPago_idx" ON "Pago"("fechaPago");

-- CreateIndex
CREATE INDEX "Contrato_inmobiliariaId_idx" ON "Contrato"("inmobiliariaId");

-- CreateIndex
CREATE INDEX "Contrato_propiedadId_idx" ON "Contrato"("propiedadId");

-- CreateIndex
CREATE INDEX "Contrato_propietarioId_idx" ON "Contrato"("propietarioId");

-- CreateIndex
CREATE INDEX "Contrato_inquilinoId_idx" ON "Contrato"("inquilinoId");

-- CreateIndex
CREATE INDEX "Contrato_garanteId_idx" ON "Contrato"("garanteId");

-- CreateIndex
CREATE INDEX "Contrato_estado_idx" ON "Contrato"("estado");

-- CreateIndex
CREATE INDEX "Propiedad_inmobiliariaId_idx" ON "Propiedad"("inmobiliariaId");

-- AddForeignKey
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_propietarioId_fkey" FOREIGN KEY ("propietarioId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_inquilinoId_fkey" FOREIGN KEY ("inquilinoId") REFERENCES "Persona"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contrato" ADD CONSTRAINT "Contrato_garanteId_fkey" FOREIGN KEY ("garanteId") REFERENCES "Persona"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidacion" ADD CONSTRAINT "Liquidacion_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidacion" ADD CONSTRAINT "Liquidacion_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidacion" ADD CONSTRAINT "Liquidacion_cerradoPorId_fkey" FOREIGN KEY ("cerradoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidacion" ADD CONSTRAINT "Liquidacion_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pago" ADD CONSTRAINT "Pago_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
