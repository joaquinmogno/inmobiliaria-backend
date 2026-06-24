CREATE TABLE "Permiso" (
    "id" SERIAL NOT NULL,
    "clave" TEXT NOT NULL,
    "descripcion" TEXT NOT NULL,
    "fechaCreacion" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Permiso_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RolPermiso" (
    "id" SERIAL NOT NULL,
    "rol" "RolUsuario" NOT NULL,
    "permisoId" INTEGER NOT NULL,

    CONSTRAINT "RolPermiso_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "UsuarioPermiso" (
    "id" SERIAL NOT NULL,
    "usuarioId" INTEGER NOT NULL,
    "permisoId" INTEGER NOT NULL,

    CONSTRAINT "UsuarioPermiso_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Permiso_clave_key" ON "Permiso"("clave");
CREATE UNIQUE INDEX "RolPermiso_rol_permisoId_key" ON "RolPermiso"("rol", "permisoId");
CREATE INDEX "RolPermiso_rol_idx" ON "RolPermiso"("rol");
CREATE UNIQUE INDEX "UsuarioPermiso_usuarioId_permisoId_key" ON "UsuarioPermiso"("usuarioId", "permisoId");
CREATE INDEX "UsuarioPermiso_usuarioId_idx" ON "UsuarioPermiso"("usuarioId");

ALTER TABLE "RolPermiso" ADD CONSTRAINT "RolPermiso_permisoId_fkey" FOREIGN KEY ("permisoId") REFERENCES "Permiso"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsuarioPermiso" ADD CONSTRAINT "UsuarioPermiso_usuarioId_fkey" FOREIGN KEY ("usuarioId") REFERENCES "Usuario"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "UsuarioPermiso" ADD CONSTRAINT "UsuarioPermiso_permisoId_fkey" FOREIGN KEY ("permisoId") REFERENCES "Permiso"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "Permiso" ("clave", "descripcion") VALUES
    ('sueldos.ver', 'Ver el módulo de sueldos'),
    ('sueldos.crear', 'Registrar pagos de sueldo'),
    ('sueldos.editar', 'Editar pagos de sueldo'),
    ('sueldos.eliminar', 'Eliminar pagos de sueldo')
ON CONFLICT ("clave") DO UPDATE SET "descripcion" = EXCLUDED."descripcion";

INSERT INTO "RolPermiso" ("rol", "permisoId")
SELECT roles."rol"::"RolUsuario", p."id"
FROM (
    VALUES ('SUPERADMIN'), ('OWNER'), ('JEFE'), ('ADMIN')
) AS roles("rol")
CROSS JOIN "Permiso" p
WHERE p."clave" IN ('sueldos.ver', 'sueldos.crear', 'sueldos.editar', 'sueldos.eliminar')
ON CONFLICT ("rol", "permisoId") DO NOTHING;
