CREATE TYPE "AmbitoMovimientoInterno" AS ENUM ('INTERNO', 'TEODORO');

-- Los registros anteriores conservan su pertenencia a Control interno.
ALTER TABLE "MovimientoInterno"
ADD COLUMN "ambito" "AmbitoMovimientoInterno" NOT NULL DEFAULT 'INTERNO';

DROP INDEX "MovimientoInterno_inmobiliariaId_fecha_id_idx";
DROP INDEX "MovimientoInterno_inmobiliariaId_anuladoEn_moneda_tipo_idx";
DROP INDEX "MovimientoInterno_inmobiliariaId_categoria_idx";
CREATE INDEX "MovimientoInterno_inmobiliariaId_ambito_fecha_id_idx"
ON "MovimientoInterno"("inmobiliariaId", "ambito", "fecha", "id");
CREATE INDEX "MovimientoInterno_ambito_totales_idx"
ON "MovimientoInterno"("inmobiliariaId", "ambito", "anuladoEn", "moneda", "tipo");
CREATE INDEX "MovimientoInterno_inmobiliariaId_ambito_categoria_idx"
ON "MovimientoInterno"("inmobiliariaId", "ambito", "categoria");

-- El administrador puede asignar estos permisos independientemente de Control interno.
INSERT INTO "Permiso" ("clave", "descripcion", "modulo", "accion") VALUES
('teodoro.ver', 'Ver Teodoro y comprobantes', 'Teodoro', 'ver'),
('teodoro.crear', 'Cargar movimientos de Teodoro', 'Teodoro', 'crear'),
('teodoro.editar', 'Editar movimientos de Teodoro', 'Teodoro', 'editar'),
('teodoro.anular', 'Anular movimientos de Teodoro', 'Teodoro', 'anular'),
('teodoro.reportes', 'Descargar reportes de Teodoro Excel y PDF', 'Teodoro', 'reportes')
ON CONFLICT ("clave") DO UPDATE SET "descripcion" = EXCLUDED."descripcion", "modulo" = EXCLUDED."modulo", "accion" = EXCLUDED."accion";
