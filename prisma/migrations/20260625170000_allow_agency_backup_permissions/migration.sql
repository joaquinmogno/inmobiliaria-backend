INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT roles.rol::"RolUsuario", p.id
FROM (
  VALUES ('OWNER'), ('JEFE'), ('ADMIN')
) AS roles(rol)
CROSS JOIN "Permiso" p
WHERE p.clave IN (
  'configuracion.backups.ver',
  'configuracion.backups.crear',
  'configuracion.backups.descargar'
)
ON CONFLICT DO NOTHING;

