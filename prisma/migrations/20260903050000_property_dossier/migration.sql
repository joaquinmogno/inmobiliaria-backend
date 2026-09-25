-- PC-026: dossier operativo de cada inmueble.
ALTER TABLE "Propiedad"
  ADD COLUMN "servicios" TEXT,
  ADD COLUMN "llaves" TEXT;

CREATE TYPE "TipoAdjuntoPropiedad" AS ENUM ('FOTO', 'DOCUMENTO');

CREATE TABLE "AdjuntoPropiedad" (
  "id" SERIAL NOT NULL,
  "rutaArchivo" TEXT NOT NULL,
  "nombreArchivo" TEXT NOT NULL,
  "tipo" "TipoAdjuntoPropiedad" NOT NULL,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "propiedadId" INTEGER NOT NULL,
  "creadoPorId" INTEGER,
  CONSTRAINT "AdjuntoPropiedad_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotaPropiedad" (
  "id" SERIAL NOT NULL,
  "contenido" TEXT NOT NULL,
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "propiedadId" INTEGER NOT NULL,
  "creadoPorId" INTEGER,
  CONSTRAINT "NotaPropiedad_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdjuntoPropiedad_propiedadId_tipo_idx"
ON "AdjuntoPropiedad"("propiedadId", "tipo");

CREATE INDEX "NotaPropiedad_propiedadId_fechaCreacion_idx"
ON "NotaPropiedad"("propiedadId", "fechaCreacion");

ALTER TABLE "AdjuntoPropiedad"
  ADD CONSTRAINT "AdjuntoPropiedad_propiedadId_fkey"
  FOREIGN KEY ("propiedadId") REFERENCES "Propiedad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdjuntoPropiedad"
  ADD CONSTRAINT "AdjuntoPropiedad_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "NotaPropiedad"
  ADD CONSTRAINT "NotaPropiedad_propiedadId_fkey"
  FOREIGN KEY ("propiedadId") REFERENCES "Propiedad"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotaPropiedad"
  ADD CONSTRAINT "NotaPropiedad_creadoPorId_fkey"
  FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;
