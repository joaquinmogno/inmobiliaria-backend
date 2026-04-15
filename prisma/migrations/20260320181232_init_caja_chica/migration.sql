-- CreateTable
CREATE TABLE "MovimientoCaja" (
    "id" SERIAL NOT NULL,
    "tipo" "TipoMovimiento" NOT NULL,
    "concepto" VARCHAR(255) NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "fecha" DATE NOT NULL,
    "metodoPago" "MetodoPago" NOT NULL DEFAULT 'EFECTIVO',
    "observaciones" TEXT,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER,
    "contratoId" INTEGER,

    CONSTRAINT "MovimientoCaja_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MovimientoCaja_inmobiliariaId_idx" ON "MovimientoCaja"("inmobiliariaId");

-- CreateIndex
CREATE INDEX "MovimientoCaja_fecha_idx" ON "MovimientoCaja"("fecha");

-- CreateIndex
CREATE INDEX "MovimientoCaja_tipo_idx" ON "MovimientoCaja"("tipo");

-- AddForeignKey
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MovimientoCaja" ADD CONSTRAINT "MovimientoCaja_contratoId_fkey" FOREIGN KEY ("contratoId") REFERENCES "Contrato"("id") ON DELETE SET NULL ON UPDATE CASCADE;
