-- CreateEnum
CREATE TYPE "EstadoPlanCuotas" AS ENUM ('ACTIVO', 'FINALIZADO', 'CANCELADO');

-- CreateEnum
CREATE TYPE "EstadoCuota" AS ENUM ('PENDIENTE', 'PAGADA');

-- CreateTable
CREATE TABLE "PlanCuotas" (
    "id" SERIAL NOT NULL,
    "concepto" TEXT NOT NULL,
    "montoTotal" DECIMAL(10,2) NOT NULL,
    "tipoMovimiento" "TipoMovimiento" NOT NULL,
    "estado" "EstadoPlanCuotas" NOT NULL DEFAULT 'ACTIVO',
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inmobiliariaId" INTEGER NOT NULL,
    "contratoId" INTEGER NOT NULL,

    CONSTRAINT "PlanCuotas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CuotaPlan" (
    "id" SERIAL NOT NULL,
    "planId" INTEGER NOT NULL,
    "numeroCuota" INTEGER NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "estado" "EstadoCuota" NOT NULL DEFAULT 'PENDIENTE',
    "movimientoId" INTEGER,
    "liquidacionId" INTEGER,

    CONSTRAINT "CuotaPlan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanCuotas_contratoId_idx" ON "PlanCuotas"("contratoId");

-- CreateIndex
CREATE INDEX "PlanCuotas_inmobiliariaId_idx" ON "PlanCuotas"("inmobiliariaId");

-- CreateIndex
CREATE UNIQUE INDEX "CuotaPlan_movimientoId_key" ON "CuotaPlan"("movimientoId");

-- CreateIndex
CREATE INDEX "CuotaPlan_planId_idx" ON "CuotaPlan"("planId");

-- CreateIndex
CREATE INDEX "CuotaPlan_liquidacionId_idx" ON "CuotaPlan"("liquidacionId");

-- AddForeignKey
ALTER TABLE "PlanCuotas" ADD CONSTRAINT "PlanCuotas_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlanCuotas" ADD CONSTRAINT "PlanCuotas_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuotaPlan" ADD CONSTRAINT "CuotaPlan_planId_fkey" FOREIGN KEY ("planId") REFERENCES "PlanCuotas"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuotaPlan" ADD CONSTRAINT "CuotaPlan_movimientoId_fkey" FOREIGN KEY ("movimientoId") REFERENCES "Movimiento"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CuotaPlan" ADD CONSTRAINT "CuotaPlan_liquidacionId_fkey" FOREIGN KEY ("liquidacionId") REFERENCES "Liquidacion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
