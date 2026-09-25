-- This deployment model has one customer per installation. Backup access is
-- therefore delegated through agency roles instead of the global SUPERADMIN.
INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT roles.rol::"RolUsuario", p.id
FROM (VALUES ('OWNER'), ('JEFE'), ('ADMIN')) AS roles(rol)
CROSS JOIN "Permiso" p
WHERE p.clave IN (
  'configuracion.backups.ver',
  'configuracion.backups.crear',
  'configuracion.backups.descargar'
)
ON CONFLICT DO NOTHING;

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT 'OWNER'::"RolUsuario", p.id
FROM "Permiso" p
WHERE p.clave = 'configuracion.backups.eliminar'
ON CONFLICT DO NOTHING;
