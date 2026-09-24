-- M-29: seguimiento humano de alertas calculadas, sin alterar operaciones.
CREATE TYPE "EstadoGestionAlerta" AS ENUM ('PENDIENTE', 'EN_SEGUIMIENTO', 'RESUELTA');
CREATE TYPE "CanalNotificacionAlerta" AS ENUM ('INTERNO', 'EMAIL', 'WHATSAPP');

CREATE TABLE "GestionAlertaOperativa" (
  "id" SERIAL NOT NULL,
  "clave" VARCHAR(80) NOT NULL,
  "titulo" VARCHAR(180) NOT NULL,
  "enlace" VARCHAR(255) NOT NULL,
  "estado" "EstadoGestionAlerta" NOT NULL DEFAULT 'PENDIENTE',
  "canal" "CanalNotificacionAlerta" NOT NULL DEFAULT 'INTERNO',
  "destinatario" VARCHAR(180),
  "proximaRevision" DATE,
  "resueltaEn" TIMESTAMP(3),
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fechaActualizacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "inmobiliariaId" INTEGER NOT NULL,
  "responsableId" INTEGER,
  "creadoPorId" INTEGER NOT NULL,
  CONSTRAINT "GestionAlertaOperativa_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RegistroGestionAlertaOperativa" (
  "id" SERIAL NOT NULL,
  "estado" "EstadoGestionAlerta" NOT NULL,
  "observacion" TEXT,
  "canal" "CanalNotificacionAlerta" NOT NULL DEFAULT 'INTERNO',
  "destinatario" VARCHAR(180),
  "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "gestionId" INTEGER NOT NULL,
  "usuarioId" INTEGER NOT NULL,
  CONSTRAINT "RegistroGestionAlertaOperativa_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GestionAlertaOperativa_inmobiliariaId_clave_key" ON "GestionAlertaOperativa"("inmobiliariaId", "clave");
CREATE INDEX "GestionAlertaOperativa_inmobiliariaId_estado_idx" ON "GestionAlertaOperativa"("inmobiliariaId", "estado");
CREATE INDEX "GestionAlertaOperativa_responsableId_estado_idx" ON "GestionAlertaOperativa"("responsableId", "estado");
CREATE INDEX "RegistroGestionAlertaOperativa_gestionId_fechaCreacion_idx" ON "RegistroGestionAlertaOperativa"("gestionId", "fechaCreacion");
CREATE INDEX "RegistroGestionAlertaOperativa_usuarioId_idx" ON "RegistroGestionAlertaOperativa"("usuarioId");

ALTER TABLE "GestionAlertaOperativa"
  ADD CONSTRAINT "GestionAlertaOperativa_inmobiliariaId_fkey" FOREIGN KEY ("inmobiliariaId") REFERENCES "Inmobiliaria"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "GestionAlertaOperativa_responsableId_fkey" FOREIGN KEY ("responsableId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "GestionAlertaOperativa_creadoPorId_fkey" FOREIGN KEY ("creadoPorId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RegistroGestionAlertaOperativa"
  ADD CONSTRAINT "RegistroGestionAlertaOperativa_gestionId_fkey" FOREIGN KEY ("gestionId") REFERENCES "GestionAlertaOperativa"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "RegistroGestionAlertaOperativa_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
