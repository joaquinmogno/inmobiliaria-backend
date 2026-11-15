CREATE TABLE "ReciboMovimiento" (
    "id" SERIAL NOT NULL,
    "inmobiliariaId" INTEGER NOT NULL,
    "movimientoCajaId" INTEGER,
    "movimientoInternoId" INTEGER,
    CONSTRAINT "ReciboMovimiento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReciboMovimiento_un_origen" CHECK (("movimientoCajaId" IS NOT NULL)::int + ("movimientoInternoId" IS NOT NULL)::int = 1)
);
CREATE TABLE "VersionReciboMovimiento" (
    "id" SERIAL NOT NULL,
    "reciboId" INTEGER NOT NULL,
    "version" INTEGER NOT NULL,
    "fechaEmision" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creadoPorId" INTEGER NOT NULL,
    "fotografia" JSONB NOT NULL,
    "huellaMovimiento" VARCHAR(64) NOT NULL,
    "motivo" VARCHAR(500),
    CONSTRAINT "VersionReciboMovimiento_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "VersionReciboMovimiento_version_positiva" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "ReciboMovimiento_movimientoCajaId_key" ON "ReciboMovimiento"("movimientoCajaId");
CREATE UNIQUE INDEX "ReciboMovimiento_movimientoInternoId_key" ON "ReciboMovimiento"("movimientoInternoId");
CREATE INDEX "ReciboMovimiento_inmobiliariaId_idx" ON "ReciboMovimiento"("inmobiliariaId");
CREATE UNIQUE INDEX "VersionReciboMovimiento_reciboId_version_key" ON "VersionReciboMovimiento"("reciboId", "version");
ALTER TABLE "ReciboMovimiento" ADD CONSTRAINT "ReciboMovimiento_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReciboMovimiento" ADD CONSTRAINT "ReciboMovimiento_movimientoCajaId_fkey" FOREIGN KEY ("movimientoCajaId") REFERENCES "MovimientoCaja"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ReciboMovimiento" ADD CONSTRAINT "ReciboMovimiento_movimientoInternoId_fkey" FOREIGN KEY ("movimientoInternoId") REFERENCES "MovimientoInterno"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VersionReciboMovimiento" ADD CONSTRAINT "VersionReciboMovimiento_reciboId_fkey" FOREIGN KEY ("reciboId") REFERENCES "ReciboMovimiento"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "VersionReciboMovimiento" ADD CONSTRAINT "VersionReciboMovimiento_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
