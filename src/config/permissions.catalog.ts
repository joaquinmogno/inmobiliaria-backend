export interface PermissionCapability {
    key: string;
    label: string;
    group: string;
    assignable: boolean;
    requires: readonly string[];
    route: string;
    control: string;
    api: readonly string[];
}

// Fuente canónica del catálogo. Cada permiso documenta la pantalla, el control
// visible y la API que habilita; los catálogos y validaciones se derivan de acá.
export const PERMISSION_CAPABILITIES = [
    { key: 'contratos.ver', label: 'Ver contratos', group: 'Contratos', assignable: true, requires: [], route: '/contratos', control: 'Listado y detalle de contratos', api: ['GET /api/contratos', 'GET /api/contratos/:id'] },
    { key: 'contratos.crear', label: 'Crear contratos', group: 'Contratos', assignable: true, requires: ['contratos.ver'], route: '/contratos', control: 'Crear contrato', api: ['POST /api/contratos'] },
    { key: 'contratos.editar', label: 'Editar contratos', group: 'Contratos', assignable: true, requires: ['contratos.ver'], route: '/contratos', control: 'Editar, actualizar y adjuntar archivos', api: ['PUT /api/contratos/:id', 'PATCH /api/contratos/:id/estado', 'POST /api/contratos/:id/adjuntos'] },
    { key: 'contratos.eliminar', label: 'Enviar contratos a papelera y eliminarlos', group: 'Contratos', assignable: true, requires: ['contratos.ver'], route: '/contratos/papelera', control: 'Eliminar contrato', api: ['DELETE /api/contratos/:id', 'DELETE /api/contratos/:id/permanente'] },
    { key: 'contratos.archivos.ver', label: 'Ver archivos de contratos', group: 'Contratos', assignable: true, requires: ['contratos.ver'], route: '/contratos', control: 'Abrir archivo del contrato', api: ['GET /api/files/:agencyDir/:filename'] },
    { key: 'contratos.restaurar', label: 'Restaurar contratos', group: 'Contratos', assignable: true, requires: ['contratos.ver'], route: '/contratos/papelera', control: 'Restaurar contrato', api: ['POST /api/contratos/:id/restaurar'] },

    { key: 'caja_chica.ver', label: 'Ver caja chica', group: 'Caja chica', assignable: true, requires: [], route: '/cajachica', control: 'Listado y saldos de caja', api: ['GET /api/cajachica', 'GET /api/cajachica/resumen'] },
    { key: 'caja_chica.crear', label: 'Crear movimientos de caja', group: 'Caja chica', assignable: true, requires: ['caja_chica.ver'], route: '/cajachica', control: 'Nuevo movimiento', api: ['POST /api/cajachica'] },
    { key: 'caja_chica.eliminar', label: 'Anular movimientos manuales de caja', group: 'Caja chica', assignable: true, requires: ['caja_chica.ver'], route: '/cajachica', control: 'Anular movimiento', api: ['POST /api/cajachica/:id/anular'] },
    { key: 'caja_chica.cerrar', label: 'Cerrar períodos de caja', group: 'Caja chica', assignable: true, requires: ['caja_chica.ver'], route: '/cajachica', control: 'Cerrar caja por período', api: ['POST /api/cajachica/cierres'] },
    { key: 'caja_chica.reabrir', label: 'Reabrir períodos de caja', group: 'Caja chica', assignable: true, requires: ['caja_chica.cerrar'], route: '/cajachica', control: 'Reabrir cierre de caja', api: ['POST /api/cajachica/cierres/:id/reabrir'] },

    { key: 'liquidaciones.ver', label: 'Ver liquidaciones', group: 'Liquidaciones', assignable: true, requires: [], route: '/liquidaciones', control: 'Listado, preparación mensual y detalle', api: ['GET /api/liquidaciones', 'GET /api/liquidaciones/preparacion', 'GET /api/liquidaciones/:id'] },
    { key: 'liquidaciones.crear', label: 'Preparar y crear liquidaciones', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones', control: 'Preparación mensual, omisiones y generación de borradores', api: ['POST /api/liquidaciones', 'POST /api/liquidaciones/generar-periodo', 'POST /api/liquidaciones/preparacion/descartar', 'POST /api/liquidaciones/preparacion/reabrir'] },
    { key: 'liquidaciones.editar', label: 'Editar liquidaciones borrador', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones/:id', control: 'Conceptos, honorarios y planes de cuotas', api: ['POST /api/liquidaciones/:id/movimientos', 'DELETE /api/liquidaciones/movimientos/:movimientoId', 'PATCH /api/liquidaciones/:id/honorarios', 'POST /api/planes-cuotas', 'POST /api/planes-cuotas/:id/cancelar', 'POST /api/planes-cuotas/:id/condonar', 'POST /api/planes-cuotas/:id/reprogramar'] },
    { key: 'liquidaciones.confirmar', label: 'Confirmar liquidaciones', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones/:id', control: 'Confirmar liquidación', api: ['PATCH /api/liquidaciones/:id/confirmar'] },
    { key: 'liquidaciones.pagar_propietario', label: 'Registrar pagos a propietarios', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones/:id', control: 'Pagar al propietario', api: ['PATCH /api/liquidaciones/:id/pagar-propietario'] },
    { key: 'liquidaciones.adelantar_propietario', label: 'Adelantar fondos a propietarios', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.pagar_propietario'], route: '/liquidaciones/:id', control: 'Pagar al propietario antes del cobro completo', api: ['PATCH /api/liquidaciones/:id/pagar-propietario'] },
    { key: 'liquidaciones.ajustar', label: 'Emitir ajustes de liquidación', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones/:id', control: 'Crear nota de crédito o débito', api: ['POST /api/liquidaciones/:id/ajustes'] },
    { key: 'liquidaciones.anular_pago_propietario', label: 'Anular pagos a propietarios', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones/:id', control: 'Anular pago al propietario', api: ['POST /api/liquidaciones/:id/anular-pago-propietario'] },
    { key: 'liquidaciones.eliminar', label: 'Eliminar liquidaciones borrador', group: 'Liquidaciones', assignable: true, requires: ['liquidaciones.ver'], route: '/liquidaciones', control: 'Eliminar liquidación', api: ['DELETE /api/liquidaciones/:id'] },

    { key: 'pagos.ver', label: 'Ver pagos', group: 'Pagos', assignable: true, requires: [], route: '/pagos', control: 'Historial de pagos', api: ['GET /api/pagos'] },
    { key: 'pagos.crear', label: 'Registrar pagos', group: 'Pagos', assignable: true, requires: ['pagos.ver', 'liquidaciones.ver'], route: '/liquidaciones/:id', control: 'Registrar pago', api: ['POST /api/pagos'] },
    { key: 'pagos.eliminar', label: 'Anular pagos', group: 'Pagos', assignable: true, requires: ['pagos.ver'], route: '/pagos', control: 'Anular pago', api: ['POST /api/pagos/:id/anular'] },

    { key: 'propiedades.ver', label: 'Ver propiedades', group: 'Propiedades', assignable: true, requires: [], route: '/propiedades', control: 'Listado, dossier y archivos de propiedades', api: ['GET /api/propiedades', 'GET /api/propiedades/:id', 'GET /api/files/:agencyDir/:filename'] },
    { key: 'propiedades.crear', label: 'Crear propiedades', group: 'Propiedades', assignable: true, requires: ['propiedades.ver'], route: '/propiedades', control: 'Nueva propiedad', api: ['POST /api/propiedades'] },
    { key: 'propiedades.editar', label: 'Editar propiedades', group: 'Propiedades', assignable: true, requires: ['propiedades.ver'], route: '/propiedades', control: 'Editar dossier, agregar notas y administrar archivos', api: ['PUT /api/propiedades/:id', 'POST /api/propiedades/:id/notas', 'POST /api/propiedades/:id/adjuntos', 'DELETE /api/propiedades/:id/adjuntos/:attachmentId'] },
    { key: 'propiedades.eliminar', label: 'Eliminar propiedades', group: 'Propiedades', assignable: true, requires: ['propiedades.ver'], route: '/propiedades', control: 'Eliminar propiedad', api: ['DELETE /api/propiedades/:id'] },

    { key: 'personas.ver', label: 'Ver personas', group: 'Personas', assignable: true, requires: [], route: '/personas', control: 'Listado de personas', api: ['GET /api/personas'] },
    { key: 'personas.crear', label: 'Crear personas', group: 'Personas', assignable: true, requires: ['personas.ver'], route: '/personas', control: 'Nueva persona', api: ['POST /api/personas'] },
    { key: 'personas.editar', label: 'Editar personas', group: 'Personas', assignable: true, requires: ['personas.ver'], route: '/personas', control: 'Editar persona', api: ['PUT /api/personas/:id'] },
    { key: 'personas.eliminar', label: 'Eliminar personas', group: 'Personas', assignable: true, requires: ['personas.ver'], route: '/personas', control: 'Eliminar persona', api: ['DELETE /api/personas/:id'] },

    { key: 'reportes.dashboard.ver', label: 'Acceder al resumen del panel', group: 'Reportes', assignable: true, requires: [], route: '/home', control: 'Resumen del mes', api: ['GET /api/reportes/dashboard'] },
    { key: 'reportes.contratos.ver', label: 'Ver métricas de contratos', group: 'Reportes', assignable: true, requires: ['reportes.dashboard.ver'], route: '/home', control: 'Indicadores de contratos', api: ['GET /api/reportes/dashboard'] },
    { key: 'reportes.morosidad.ver', label: 'Ver indicador de morosidad', group: 'Reportes', assignable: true, requires: ['reportes.dashboard.ver'], route: '/home', control: 'Indicador de morosidad', api: ['GET /api/reportes/dashboard'] },
    { key: 'reportes.financieros.ver', label: 'Ver métricas financieras', group: 'Reportes', assignable: true, requires: ['reportes.dashboard.ver'], route: '/home', control: 'Indicadores financieros por moneda', api: ['GET /api/reportes/dashboard'] },

    { key: 'sueldos.ver', label: 'Ver sueldos', group: 'Sueldos', assignable: true, requires: [], route: '/sueldos', control: 'Listado de sueldos', api: ['GET /api/sueldos'] },
    { key: 'sueldos.crear', label: 'Registrar sueldos', group: 'Sueldos', assignable: true, requires: ['sueldos.ver'], route: '/sueldos', control: 'Registrar sueldo', api: ['POST /api/sueldos'] },
    { key: 'sueldos.editar', label: 'Editar sueldos', group: 'Sueldos', assignable: true, requires: ['sueldos.ver'], route: '/sueldos', control: 'Editar sueldo', api: ['PUT /api/sueldos/:id'] },
    { key: 'sueldos.eliminar', label: 'Eliminar sueldos', group: 'Sueldos', assignable: true, requires: ['sueldos.ver'], route: '/sueldos', control: 'Eliminar sueldo', api: ['DELETE /api/sueldos/:id'] },

    { key: 'usuarios.ver', label: 'Ver usuarios', group: 'Usuarios', assignable: false, requires: [], route: '/usuarios', control: 'Listado de usuarios', api: ['GET /api/usuarios'] },
    { key: 'usuarios.crear', label: 'Crear usuarios', group: 'Usuarios', assignable: false, requires: ['usuarios.ver'], route: '/usuarios', control: 'Crear usuario', api: ['POST /api/usuarios'] },
    { key: 'usuarios.editar', label: 'Editar usuarios', group: 'Usuarios', assignable: false, requires: ['usuarios.ver'], route: '/usuarios', control: 'Editar usuario', api: ['PUT /api/usuarios/:id'] },
    { key: 'usuarios.eliminar', label: 'Deshabilitar usuarios', group: 'Usuarios', assignable: false, requires: ['usuarios.ver'], route: '/usuarios', control: 'Deshabilitar usuario', api: ['DELETE /api/usuarios/:id'] },
    { key: 'usuarios.permisos', label: 'Administrar roles', group: 'Usuarios', assignable: false, requires: ['usuarios.ver'], route: '/usuarios', control: 'Crear y editar roles', api: ['POST /api/roles', 'PUT /api/roles/:id'] },
    { key: 'usuarios.asignar_rol', label: 'Asignar roles', group: 'Usuarios', assignable: false, requires: ['usuarios.ver'], route: '/usuarios', control: 'Asignar rol a usuario', api: ['PUT /api/usuarios/:id'] },

    { key: 'configuracion.perfil.ver', label: 'Ver perfil de la inmobiliaria', group: 'Configuración', assignable: false, requires: [], route: '/configuracion', control: 'Perfil de la inmobiliaria', api: ['GET /api/inmobiliaria/me'] },
    { key: 'configuracion.perfil.editar', label: 'Editar perfil de la inmobiliaria', group: 'Configuración', assignable: false, requires: ['configuracion.perfil.ver'], route: '/configuracion', control: 'Guardar perfil', api: ['PUT /api/inmobiliaria/me'] },
    { key: 'configuracion.backups.ver', label: 'Ver backups', group: 'Configuración', assignable: false, requires: [], route: '/configuracion', control: 'Listado de backups', api: ['GET /api/backups'] },
    { key: 'configuracion.backups.crear', label: 'Crear backups', group: 'Configuración', assignable: false, requires: ['configuracion.backups.ver'], route: '/configuracion', control: 'Crear backup', api: ['POST /api/backups/db', 'POST /api/backups/uploads'] },
    { key: 'configuracion.backups.eliminar', label: 'Eliminar backups', group: 'Configuración', assignable: false, requires: ['configuracion.backups.ver'], route: '/configuracion', control: 'Eliminar backup', api: ['DELETE /api/backups/:type/:filename'] },
    { key: 'configuracion.backups.descargar', label: 'Descargar backups', group: 'Configuración', assignable: false, requires: ['configuracion.backups.ver'], route: '/configuracion', control: 'Descargar backup', api: ['GET /api/backups/download/:type/:filename'] },
    { key: 'configuracion.auditoria.ver', label: 'Ver auditoría', group: 'Configuración', assignable: false, requires: [], route: '/configuracion', control: 'Registro de auditoría', api: ['GET /api/inmobiliaria/logs'] }
] as const satisfies readonly PermissionCapability[];

export type PermissionKey = typeof PERMISSION_CAPABILITIES[number]['key'];

export const MODULE_PERMISSIONS = PERMISSION_CAPABILITIES.map(capability => capability.key) as PermissionKey[];
export const ROLE_PERMISSION_CAPABILITIES = PERMISSION_CAPABILITIES.filter(capability => capability.assignable);
export const ROLE_ASSIGNABLE_PERMISSIONS = ROLE_PERMISSION_CAPABILITIES.map(capability => capability.key) as PermissionKey[];
export const PERMISSION_CAPABILITY_BY_KEY = new Map<string, PermissionCapability>(
    PERMISSION_CAPABILITIES.map(capability => [capability.key, capability])
);

export const SUELDOS_PERMISSIONS = PERMISSION_CAPABILITIES
    .filter(capability => capability.group === 'Sueldos')
    .map(capability => capability.key);

export function getMissingPermissionDependencies(keys: readonly string[]) {
    const selected = new Set(keys);
    return keys.flatMap(key => {
        const capability = PERMISSION_CAPABILITY_BY_KEY.get(key);
        return capability?.requires.filter(required => !selected.has(required)).map(required => ({ key, required })) || [];
    });
}
