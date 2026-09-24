-- PC-017: el catálogo asignable debe representar únicamente capacidades reales.
-- Los permisos administrativos no pertenecen a roles de usuarios comunes.
DELETE FROM "RolPermiso" rp
USING "Permiso" p
WHERE rp."permisoId" = p."id"
  AND (p."clave" LIKE 'usuarios.%' OR p."clave" LIKE 'configuracion.%');

-- Estos permisos nunca tuvieron acción, control ni endpoint asociado.
DELETE FROM "RolPermiso" rp
USING "Permiso" p
WHERE rp."permisoId" = p."id"
  AND p."clave" IN ('pagos.editar', 'caja_chica.editar');

DELETE FROM "Permiso"
WHERE "clave" IN ('pagos.editar', 'caja_chica.editar');

UPDATE "Permiso" SET "descripcion" = 'Anular pagos', "modulo" = 'Pagos', "accion" = 'eliminar'
WHERE "clave" = 'pagos.eliminar';
UPDATE "Permiso" SET "descripcion" = 'Anular movimientos manuales de caja', "modulo" = 'Caja chica', "accion" = 'eliminar'
WHERE "clave" = 'caja_chica.eliminar';
UPDATE "Permiso" SET "descripcion" = 'Enviar contratos a papelera y eliminarlos', "modulo" = 'Contratos', "accion" = 'eliminar'
WHERE "clave" = 'contratos.eliminar';

-- Conserva la intención de roles existentes agregando los accesos de navegación
-- imprescindibles para llegar a cada acción que ya tenían asignada.
WITH dependencias("capacidad", "requerido") AS (
  VALUES
    ('contratos.crear', 'contratos.ver'),
    ('contratos.editar', 'contratos.ver'),
    ('contratos.eliminar', 'contratos.ver'),
    ('contratos.archivos.ver', 'contratos.ver'),
    ('contratos.restaurar', 'contratos.ver'),
    ('caja_chica.crear', 'caja_chica.ver'),
    ('caja_chica.eliminar', 'caja_chica.ver'),
    ('liquidaciones.crear', 'liquidaciones.ver'),
    ('liquidaciones.editar', 'liquidaciones.ver'),
    ('liquidaciones.eliminar', 'liquidaciones.ver'),
    ('pagos.crear', 'pagos.ver'),
    ('pagos.crear', 'liquidaciones.ver'),
    ('pagos.eliminar', 'pagos.ver'),
    ('propiedades.crear', 'propiedades.ver'),
    ('propiedades.editar', 'propiedades.ver'),
    ('propiedades.eliminar', 'propiedades.ver'),
    ('personas.crear', 'personas.ver'),
    ('personas.editar', 'personas.ver'),
    ('personas.eliminar', 'personas.ver'),
    ('reportes.contratos.ver', 'reportes.dashboard.ver'),
    ('reportes.morosidad.ver', 'reportes.dashboard.ver'),
    ('reportes.financieros.ver', 'reportes.dashboard.ver'),
    ('sueldos.crear', 'sueldos.ver'),
    ('sueldos.editar', 'sueldos.ver'),
    ('sueldos.eliminar', 'sueldos.ver')
)
INSERT INTO "RolPermiso" ("rolId", "permisoId")
SELECT DISTINCT asignado."rolId", requerido."id"
FROM "RolPermiso" asignado
JOIN "Permiso" capacidad ON capacidad."id" = asignado."permisoId"
JOIN dependencias d ON d."capacidad" = capacidad."clave"
JOIN "Permiso" requerido ON requerido."clave" = d."requerido"
ON CONFLICT ("rolId", "permisoId") DO NOTHING;
