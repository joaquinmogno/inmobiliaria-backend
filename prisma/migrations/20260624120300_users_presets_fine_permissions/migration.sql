INSERT INTO "Permiso" ("clave", "descripcion") VALUES
    ('usuarios.ver', 'Ver usuarios'),
    ('usuarios.crear', 'Crear usuarios'),
    ('usuarios.editar', 'Editar usuarios'),
    ('usuarios.eliminar', 'Eliminar usuarios'),
    ('usuarios.permisos', 'Administrar permisos de usuarios'),
    ('configuracion.perfil.ver', 'Ver perfil de la inmobiliaria'),
    ('configuracion.perfil.editar', 'Editar perfil de la inmobiliaria'),
    ('configuracion.backups.ver', 'Ver backups'),
    ('configuracion.backups.crear', 'Crear backups'),
    ('configuracion.backups.eliminar', 'Eliminar backups'),
    ('configuracion.auditoria.ver', 'Ver auditoría'),
    ('reportes.dashboard.ver', 'Ver dashboard de reportes'),
    ('reportes.financieros.ver', 'Ver reportes financieros sensibles')
ON CONFLICT ("clave") DO UPDATE SET "descripcion" = EXCLUDED."descripcion";

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT roles."rol"::"RolUsuario", p."id"
FROM (
    VALUES ('SUPERADMIN'), ('OWNER'), ('JEFE'), ('ADMIN')
) AS roles("rol")
CROSS JOIN "Permiso" p
WHERE p."clave" IN (
    'usuarios.ver', 'usuarios.crear', 'usuarios.editar', 'usuarios.eliminar', 'usuarios.permisos',
    'configuracion.perfil.ver', 'configuracion.perfil.editar',
    'configuracion.backups.ver', 'configuracion.backups.crear', 'configuracion.backups.eliminar',
    'configuracion.auditoria.ver',
    'reportes.dashboard.ver', 'reportes.financieros.ver'
)
ON CONFLICT ("rol", "permisoId") DO NOTHING;

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT 'AGENTE'::"RolUsuario", p."id"
FROM "Permiso" p
WHERE p."clave" IN (
    'configuracion.perfil.ver',
    'reportes.dashboard.ver'
)
ON CONFLICT ("rol", "permisoId") DO NOTHING;
