INSERT INTO "Permiso" ("clave", "descripcion") VALUES
    ('reportes.contratos.ver', 'Ver métricas de contratos'),
    ('reportes.morosidad.ver', 'Ver métricas de morosidad'),
    ('configuracion.backups.descargar', 'Descargar backups'),
    ('contratos.archivos.ver', 'Ver archivos de contratos'),
    ('contratos.restaurar', 'Restaurar contratos')
ON CONFLICT ("clave") DO NOTHING;

WITH mappings(old_key, new_key) AS (
    VALUES
        ('configuracion.ver', 'configuracion.perfil.ver'),
        ('configuracion.ver', 'configuracion.backups.ver'),
        ('configuracion.ver', 'configuracion.auditoria.ver'),
        ('configuracion.editar', 'configuracion.perfil.editar'),
        ('configuracion.editar', 'configuracion.backups.crear'),
        ('configuracion.editar', 'configuracion.backups.eliminar'),
        ('configuracion.editar', 'configuracion.backups.descargar'),
        ('reportes.ver', 'reportes.dashboard.ver'),
        ('reportes.ver', 'reportes.contratos.ver'),
        ('reportes.ver', 'reportes.morosidad.ver'),
        ('reportes.ver', 'reportes.financieros.ver')
)
INSERT INTO "UsuarioPermiso" ("usuarioId", "permisoId")
SELECT DISTINCT up."usuarioId", new_perm.id
FROM "UsuarioPermiso" up
JOIN "Permiso" old_perm ON old_perm.id = up."permisoId"
JOIN mappings m ON m.old_key = old_perm.clave
JOIN "Permiso" new_perm ON new_perm.clave = m.new_key
ON CONFLICT ("usuarioId", "permisoId") DO NOTHING;

WITH mappings(old_key, new_key) AS (
    VALUES
        ('configuracion.ver', 'configuracion.perfil.ver'),
        ('configuracion.ver', 'configuracion.backups.ver'),
        ('configuracion.ver', 'configuracion.auditoria.ver'),
        ('configuracion.editar', 'configuracion.perfil.editar'),
        ('configuracion.editar', 'configuracion.backups.crear'),
        ('configuracion.editar', 'configuracion.backups.eliminar'),
        ('configuracion.editar', 'configuracion.backups.descargar'),
        ('reportes.ver', 'reportes.dashboard.ver'),
        ('reportes.ver', 'reportes.contratos.ver'),
        ('reportes.ver', 'reportes.morosidad.ver'),
        ('reportes.ver', 'reportes.financieros.ver')
)
INSERT INTO "UsuarioPermisoDenegado" ("usuarioId", "permisoId")
SELECT DISTINCT upd."usuarioId", new_perm.id
FROM "UsuarioPermisoDenegado" upd
JOIN "Permiso" old_perm ON old_perm.id = upd."permisoId"
JOIN mappings m ON m.old_key = old_perm.clave
JOIN "Permiso" new_perm ON new_perm.clave = m.new_key
ON CONFLICT ("usuarioId", "permisoId") DO NOTHING;

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT r.rol::"RolUsuario", p.id
FROM (VALUES ('OWNER'), ('JEFE')) AS r(rol)
CROSS JOIN "Permiso" p
WHERE p.clave NOT IN ('configuracion.ver', 'configuracion.editar', 'reportes.ver')
ON CONFLICT ("rol", "permisoId") DO NOTHING;

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT 'ADMIN'::"RolUsuario", p.id
FROM "Permiso" p
WHERE p.clave IN (
    'configuracion.perfil.ver',
    'configuracion.backups.ver',
    'configuracion.backups.descargar',
    'reportes.dashboard.ver',
    'reportes.contratos.ver',
    'reportes.morosidad.ver',
    'contratos.archivos.ver',
    'contratos.restaurar'
)
ON CONFLICT ("rol", "permisoId") DO NOTHING;

WITH chosen_managers AS (
    SELECT DISTINCT ON (u."inmobiliariaId") u.id
    FROM "Usuario" u
    WHERE NOT EXISTS (
        SELECT 1
        FROM "Usuario" manager
        JOIN "Permiso" p ON p.clave = 'usuarios.permisos'
        LEFT JOIN "UsuarioPermisoDenegado" denied
            ON denied."usuarioId" = manager.id
            AND denied."permisoId" = p.id
        WHERE manager."inmobiliariaId" = u."inmobiliariaId"
            AND denied.id IS NULL
            AND (
                EXISTS (
                    SELECT 1
                    FROM "RolPermiso" rp
                    WHERE rp.rol = manager.rol
                        AND rp."permisoId" = p.id
                )
                OR EXISTS (
                    SELECT 1
                    FROM "UsuarioPermiso" up
                    WHERE up."usuarioId" = manager.id
                        AND up."permisoId" = p.id
                )
            )
    )
    ORDER BY u."inmobiliariaId",
        CASE u.rol
            WHEN 'OWNER' THEN 0
            WHEN 'JEFE' THEN 1
            WHEN 'ADMIN' THEN 2
            ELSE 3
        END,
        u."fechaCreacion" ASC
)
DELETE FROM "UsuarioPermisoDenegado" upd
USING chosen_managers cm, "Permiso" p
WHERE upd."usuarioId" = cm.id
    AND upd."permisoId" = p.id
    AND p.clave = 'usuarios.permisos';

WITH chosen_managers AS (
    SELECT DISTINCT ON (u."inmobiliariaId") u.id
    FROM "Usuario" u
    WHERE NOT EXISTS (
        SELECT 1
        FROM "Usuario" manager
        JOIN "Permiso" p ON p.clave = 'usuarios.permisos'
        LEFT JOIN "UsuarioPermisoDenegado" denied
            ON denied."usuarioId" = manager.id
            AND denied."permisoId" = p.id
        WHERE manager."inmobiliariaId" = u."inmobiliariaId"
            AND denied.id IS NULL
            AND (
                EXISTS (
                    SELECT 1
                    FROM "RolPermiso" rp
                    WHERE rp.rol = manager.rol
                        AND rp."permisoId" = p.id
                )
                OR EXISTS (
                    SELECT 1
                    FROM "UsuarioPermiso" up
                    WHERE up."usuarioId" = manager.id
                        AND up."permisoId" = p.id
                )
            )
    )
    ORDER BY u."inmobiliariaId",
        CASE u.rol
            WHEN 'OWNER' THEN 0
            WHEN 'JEFE' THEN 1
            WHEN 'ADMIN' THEN 2
            ELSE 3
        END,
        u."fechaCreacion" ASC
)
INSERT INTO "UsuarioPermiso" ("usuarioId", "permisoId")
SELECT cm.id, p.id
FROM chosen_managers cm
JOIN "Permiso" p ON p.clave = 'usuarios.permisos'
ON CONFLICT ("usuarioId", "permisoId") DO NOTHING;

DELETE FROM "Permiso"
WHERE clave IN ('configuracion.ver', 'configuracion.editar', 'reportes.ver');
