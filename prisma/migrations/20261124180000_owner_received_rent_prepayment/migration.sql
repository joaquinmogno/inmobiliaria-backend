-- AlterTable
ALTER TABLE "Liquidacion" ADD COLUMN     "anticipoAlquilerId" INTEGER,
ADD COLUMN     "cobradoPropietarioARS" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "cobradoPropietarioUSD" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "montoAlquilerAnticipado" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "AnticipoAlquiler" (
    "id" SERIAL NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "contratoId" INTEGER NOT NULL,
    "periodoDesde" DATE NOT NULL,
    "periodoHasta" DATE NOT NULL,
    "fechaPago" DATE NOT NULL,
    "montoMensual" DECIMAL(10,2) NOT NULL,
    "montoTotal" DECIMAL(12,2) NOT NULL,
    "moneda" "Moneda" NOT NULL,
    "propietarioNombre" TEXT NOT NULL,
    "observaciones" TEXT NOT NULL,
    "creadoPorId" INTEGER NOT NULL,
    "creadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anuladoEn" TIMESTAMP(3),
    "motivoAnulacion" TEXT,

    CONSTRAINT "AnticipoAlquiler_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CobroPropietario" (
    "id" SERIAL NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "liquidacionId" INTEGER NOT NULL,
    "movimientoCajaId" INTEGER NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "moneda" "Moneda" NOT NULL,
    "fechaPago" DATE NOT NULL,
    "creadoPorId" INTEGER NOT NULL,
    "anuladoEn" TIMESTAMP(3),
    "motivoAnulacion" TEXT,

    CONSTRAINT "CobroPropietario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnticipoAlquiler_contratoId_periodoDesde_periodoHasta_idx" ON "AnticipoAlquiler"("contratoId", "periodoDesde", "periodoHasta");

-- CreateIndex
CREATE UNIQUE INDEX "AnticipoAlquiler_id_inmobiliariaId_key" ON "AnticipoAlquiler"("id", "inmobiliariaId");

-- CreateIndex
CREATE UNIQUE INDEX "CobroPropietario_movimientoCajaId_key" ON "CobroPropietario"("movimientoCajaId");

-- CreateIndex
CREATE INDEX "CobroPropietario_liquidacionId_idx" ON "CobroPropietario"("liquidacionId");

-- CreateIndex
CREATE UNIQUE INDEX "CobroPropietario_movimientoCajaId_inmobiliariaId_key" ON "CobroPropietario"("movimientoCajaId", "inmobiliariaId");

-- CreateIndex
CREATE UNIQUE INDEX "Contrato_id_inmobiliariaId_key" ON "Contrato"("id", "inmobiliariaId");

-- CreateIndex
CREATE UNIQUE INDEX "Liquidacion_id_inmobiliariaId_key" ON "Liquidacion"("id", "inmobiliariaId");

-- AddForeignKey
ALTER TABLE "AnticipoAlquiler" ADD CONSTRAINT "AnticipoAlquiler_contratoId_inmobiliariaId_fkey" FOREIGN KEY ("contratoId", "inmobiliariaId") REFERENCES "Contrato"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CobroPropietario" ADD CONSTRAINT "CobroPropietario_liquidacionId_inmobiliariaId_fkey" FOREIGN KEY ("liquidacionId", "inmobiliariaId") REFERENCES "Liquidacion"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CobroPropietario" ADD CONSTRAINT "CobroPropietario_movimientoCajaId_inmobiliariaId_fkey" FOREIGN KEY ("movimientoCajaId", "inmobiliariaId") REFERENCES "MovimientoCaja"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Liquidacion" ADD CONSTRAINT "Liquidacion_anticipoAlquilerId_inmobiliariaId_fkey" FOREIGN KEY ("anticipoAlquilerId", "inmobiliariaId") REFERENCES "AnticipoAlquiler"("id", "inmobiliariaId") ON DELETE RESTRICT ON UPDATE CASCADE;

