-- CreateTable
CREATE TABLE "PagoSueldo" (
    "id" SERIAL NOT NULL,
    "monto" DECIMAL(10,2) NOT NULL,
    "fecha" DATE NOT NULL,
    "periodo" TEXT NOT NULL,
    "metodoPago" "MetodoPago" NOT NULL DEFAULT 'EFECTIVO',
    "observaciones" TEXT,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usuarioId" INTEGER NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER NOT NULL,

    CONSTRAINT "PagoSueldo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PagoSueldo_usuarioId_idx" ON "PagoSueldo"("usuarioId");

-- CreateIndex
CREATE INDEX "PagoSueldo_inmobiliariaId_idx" ON "PagoSueldo"("inmobiliariaId");

-- CreateIndex
CREATE INDEX "PagoSueldo_periodo_idx" ON "PagoSueldo"("periodo");

-- AddForeignKey
ALTER TABLE "PagoSueldo" ADD CONSTRAINT "PagoSueldo_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoSueldo" ADD CONSTRAINT "PagoSueldo_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PagoSueldo" ADD CONSTRAINT "PagoSueldo_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
