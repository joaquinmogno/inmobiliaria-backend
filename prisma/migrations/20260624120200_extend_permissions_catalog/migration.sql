CREATE TABLE "UsuarioPermisoDenegado" (
    "id" SERIAL NOT NULL,
    "usuarioId" INTEGER NOT NULL,
    "permisoId" INTEGER NOT NULL,

    CONSTRAINT "UsuarioPermisoDenegado_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UsuarioPermisoDenegado_usuarioId_permisoId_key" ON "UsuarioPermisoDenegado"("usuarioId", "permisoId");
CREATE INDEX "UsuarioPermisoDenegado_usuarioId_idx" ON "UsuarioPermisoDenegado"("usuarioId");

ALTER TABLE "UsuarioPermisoDenegado" ADD CONSTRAINT "UsuarioPermisoDenegado_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsuarioPermisoDenegado" ADD CONSTRAINT "UsuarioPermisoDenegado_permisoId_fkey" FOREIGN KEY ("permisoId") REFERENCES "Permiso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Permiso" ("clave", "descripcion") VALUES
    ('contratos.ver', 'Ver contratos'),
    ('contratos.crear', 'Crear contratos'),
    ('contratos.editar', 'Editar contratos'),
    ('contratos.eliminar', 'Eliminar contratos'),
    ('caja_chica.ver', 'Ver caja chica'),
    ('caja_chica.crear', 'Crear movimientos de caja chica'),
    ('caja_chica.editar', 'Editar movimientos de caja chica'),
    ('caja_chica.eliminar', 'Eliminar movimientos de caja chica'),
    ('liquidaciones.ver', 'Ver liquidaciones'),
    ('liquidaciones.crear', 'Crear liquidaciones'),
    ('liquidaciones.editar', 'Editar liquidaciones'),
    ('liquidaciones.eliminar', 'Eliminar liquidaciones'),
    ('pagos.ver', 'Ver pagos'),
    ('pagos.crear', 'Crear pagos'),
    ('pagos.editar', 'Editar pagos'),
    ('pagos.eliminar', 'Eliminar pagos'),
    ('propiedades.ver', 'Ver propiedades'),
    ('propiedades.crear', 'Crear propiedades'),
    ('propiedades.editar', 'Editar propiedades'),
    ('propiedades.eliminar', 'Eliminar propiedades'),
    ('personas.ver', 'Ver personas'),
    ('personas.crear', 'Crear personas'),
    ('personas.editar', 'Editar personas'),
    ('personas.eliminar', 'Eliminar personas'),
    ('configuracion.ver', 'Ver configuración'),
    ('configuracion.editar', 'Editar configuración'),
    ('reportes.ver', 'Ver reportes')
ON CONFLICT ("clave") DO UPDATE SET "descripcion" = EXCLUDED."descripcion";

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT roles."rol"::"RolUsuario", p."id"
FROM (
    VALUES ('SUPERADMIN'), ('OWNER'), ('JEFE'), ('ADMIN')
) AS roles("rol")
CROSS JOIN "Permiso" p
ON CONFLICT ("rol", "permisoId") DO NOTHING;

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT 'AGENTE'::"RolUsuario", p."id"
FROM "Permiso" p
WHERE p."clave" IN (
    'contratos.ver', 'contratos.crear', 'contratos.editar', 'contratos.eliminar',
    'caja_chica.ver', 'caja_chica.crear', 'caja_chica.editar', 'caja_chica.eliminar',
    'liquidaciones.ver', 'liquidaciones.crear', 'liquidaciones.editar', 'liquidaciones.eliminar',
    'pagos.ver', 'pagos.crear', 'pagos.editar', 'pagos.eliminar',
    'propiedades.ver', 'propiedades.crear', 'propiedades.editar', 'propiedades.eliminar',
    'personas.ver', 'personas.crear', 'personas.editar', 'personas.eliminar',
    'reportes.ver'
)
ON CONFLICT ("rol", "permisoId") DO NOTHING;
