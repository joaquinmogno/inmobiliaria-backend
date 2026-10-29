CREATE TYPE "TipoMovimientoInterno" AS ENUM ('INGRESO', 'GASTO');

CREATE TABLE "MovimientoInterno" (
    "id" SERIAL NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "fecha" DATE NOT NULL,
    "tipo" "TipoMovimientoInterno" NOT NULL DEFAULT 'GASTO',
    "detalle" VARCHAR(255) NOT NULL,
    "monto" DECIMAL(14,2) NOT NULL,
    "moneda" "Moneda" NOT NULL DEFAULT 'ARS',
    "categoria" VARCHAR(80),
    "metodoPago" VARCHAR(80),
    "observaciones" VARCHAR(2000),
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fechaActualizacion" TIMESTAMP(3) NOT NULL,
    "anuladoEn" TIMESTAMP(3),
    "motivoAnulacion" VARCHAR(1000),
    "inmobiliariaId" INTEGER NOT NULL,
    "creadoPorId" INTEGER NOT NULL,
    "actualizadoPorId" INTEGER,
    "anuladoPorId" INTEGER,
    CONSTRAINT "MovimientoInterno_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MovimientoInterno_monto_positivo" CHECK ("monto" > 0),
    CONSTRAINT "MovimientoInterno_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MovimientoInterno_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MovimientoInterno_actualizadoPorId_fkey" FOREIGN KEY ("actualizadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MovimientoInterno_anuladoPorId_fkey" FOREIGN KEY ("anuladoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "MovimientoInterno_inmobiliariaId_fecha_id_idx" ON "MovimientoInterno"("inmobiliariaId", "fecha", "id");
CREATE INDEX "MovimientoInterno_inmobiliariaId_anuladoEn_moneda_tipo_idx" ON "MovimientoInterno"("inmobiliariaId", "anuladoEn", "moneda", "tipo");
CREATE INDEX "MovimientoInterno_inmobiliariaId_categoria_idx" ON "MovimientoInterno"("inmobiliariaId", "categoria");

CREATE TABLE "AdjuntoMovimientoInterno" (
    "id" SERIAL NOT NULL,
    "movimientoInternoId" INTEGER NOT NULL,
    "rutaArchivo" TEXT NOT NULL,
    "nombreArchivo" VARCHAR(255) NOT NULL,
    "tipoContenido" VARCHAR(100) NOT NULL,
    "tamano" INTEGER NOT NULL,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "creadoPorId" INTEGER NOT NULL,
    CONSTRAINT "AdjuntoMovimientoInterno_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdjuntoMovimientoInterno_movimientoInternoId_fkey" FOREIGN KEY ("movimientoInternoId") REFERENCES "MovimientoInterno"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "AdjuntoMovimientoInterno_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AdjuntoMovimientoInterno_rutaArchivo_key" ON "AdjuntoMovimientoInterno"("rutaArchivo");
CREATE INDEX "AdjuntoMovimientoInterno_movimientoInternoId_idx" ON "AdjuntoMovimientoInterno"("movimientoInternoId");

-- El catálogo queda disponible al desplegar. No se conceden permisos a roles existentes.
INSERT INTO "Permiso" ("clave", "descripcion", "modulo", "accion") VALUES
('control_interno.ver', 'Ver control interno y comprobantes', 'Control interno', 'ver'),
('control_interno.crear', 'Cargar movimientos internos', 'Control interno', 'crear'),
('control_interno.editar', 'Editar movimientos internos', 'Control interno', 'editar'),
('control_interno.anular', 'Anular movimientos internos', 'Control interno', 'anular'),
('control_interno.reportes', 'Descargar reportes internos Excel y PDF', 'Control interno', 'reportes')
ON CONFLICT ("clave") DO UPDATE SET "descripcion" = EXCLUDED."descripcion", "modulo" = EXCLUDED."modulo", "accion" = EXCLUDED."accion";
