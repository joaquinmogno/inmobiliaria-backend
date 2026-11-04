-- Los movimientos existentes conservan su ámbito; Daniel comienza vacío.
ALTER TYPE "AmbitoMovimientoInterno" ADD VALUE 'DANIEL';

-- Los permisos de Daniel se asignan independientemente de los otros apartados.
INSERT INTO "Permiso" ("clave", "descripcion", "modulo", "accion") VALUES
('daniel.ver', 'Ver Daniel y comprobantes', 'Daniel', 'ver'),
('daniel.crear', 'Cargar movimientos de Daniel', 'Daniel', 'crear'),
('daniel.editar', 'Editar movimientos de Daniel', 'Daniel', 'editar'),
('daniel.anular', 'Anular movimientos de Daniel', 'Daniel', 'anular'),
('daniel.reportes', 'Descargar reportes de Daniel Excel y PDF', 'Daniel', 'reportes')
ON CONFLICT ("clave") DO UPDATE SET "descripcion" = EXCLUDED."descripcion", "modulo" = EXCLUDED."modulo", "accion" = EXCLUDED."accion";
