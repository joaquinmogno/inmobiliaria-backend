import { Prisma } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { getTenantSettlement } from './tenant-credit.service';

type Totals = {
    totalIngresos: number;
    totalDescuentos: number;
    netoACobrar: number;
    montoPropietario: number;
    montoHonorarios: number;
    montoAlquilerBase: number;
};

export type LiquidationVoucherSnapshot = {
    schemaVersion: 1;
    version: number;
    emitidoEn: string;
    totalesOriginales: Totals;
    liquidacion: {
        id: number;
        estado: string;
        periodo: string;
        fechaCreacion: string;
        fechaConfirmacion: string | null;
        fechaVencimiento: string | null;
        moneda: string;
        totales: Totals;
        pagaHonorarios: string;
        porcentajeHonorarios: number | null;
        propiedadDireccion: string | null;
        inquilinoNombre: string | null;
        propietarioNombre: string | null;
    };
    contrato: {
        id: number;
        fechaInicio: string;
        fechaFin: string;
        fechaProximaActualizacion: string | null;
        requiereActualizacion: boolean;
        tipoAjuste: string | null;
        porcentajeActualizacion: number | null;
        pagaHonorarios: string;
        propiedad: Record<string, unknown>;
        inquilinos: Array<{ id: number; esPrincipal: boolean; persona: Record<string, unknown> }>;
        propietarios: Array<{ id: number; esPrincipal: boolean; persona: Record<string, unknown> }>;
    };
    movimientos: Array<{ id: number; tipo: string; concepto: string; monto: number; esParaInmobiliaria: boolean; observaciones: string | null }>;
    pagos: Array<{ id: number; monto: number; fechaPago: string; metodoPago: string; comprobante: string | null; observaciones: string | null }>;
    aplicacionesCredito: Array<{ id: number; monto: number; fechaAplicacion: string; creditoInquilinoId: number; concepto: string }>;
    deudaAnterior: {
        totalDeuda: number;
        moneda: string;
        detalle: Array<{ id: number; periodo: string; neto: number; pagado: number; creditosAplicados: number; deuda: number; moneda: string; estado: string }>;
    };
    ajustes: Array<{
        id: number;
        tipo: string;
        concepto: string;
        motivo: string;
        monto: number;
        impactoInquilino: number;
        impactoPropietario: number;
        fechaCreacion: string;
        creadoPor: { id: number; nombreCompleto: string };
        creditoInquilino: { id: number; saldoPendiente: number; estado: string; destino: string } | null;
    }>;
};

const asNumber = (value: Decimal | number | string | null | undefined) => Number(value || 0);
const asDate = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;

const selectPersona = (persona: any) => ({
    id: persona.id,
    nombreCompleto: persona.nombreCompleto,
    dni: persona.dni || null,
    cuit: persona.cuit || null,
    email: persona.email || null,
    telefono: persona.telefono || null,
    direccion: persona.direccion || null
});

const totalsOf = (liquidacion: any): Totals => ({
    totalIngresos: asNumber(liquidacion.totalIngresos),
    totalDescuentos: asNumber(liquidacion.totalDescuentos),
    netoACobrar: asNumber(liquidacion.netoACobrar),
    montoPropietario: asNumber(liquidacion.montoPropietario),
    montoHonorarios: asNumber(liquidacion.montoHonorarios),
    montoAlquilerBase: asNumber(liquidacion.montoAlquilerBase)
});

export const readLiquidationVoucherSnapshot = (value: Prisma.JsonValue | null | undefined): LiquidationVoucherSnapshot | null => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const snapshot = value as unknown as LiquidationVoucherSnapshot;
    return snapshot.schemaVersion === 1 && snapshot.liquidacion && snapshot.contrato ? snapshot : null;
};

export const getVoucherSummary = (voucher: { id: number; version: number; fechaEmision: Date; creadoPor: { id: number; nombreCompleto: string }; fotografia: Prisma.JsonValue }) => {
    const snapshot = readLiquidationVoucherSnapshot(voucher.fotografia);
    return {
        id: voucher.id,
        version: voucher.version,
        fechaEmision: voucher.fechaEmision,
        creadoPor: voucher.creadoPor,
        moneda: snapshot?.liquidacion.moneda || 'ARS',
        importeOriginal: snapshot?.totalesOriginales.netoACobrar || 0,
        importeCorregido: snapshot?.liquidacion.totales.netoACobrar || 0,
        importePropietarioOriginal: snapshot?.totalesOriginales.montoPropietario || 0,
        importePropietarioCorregido: snapshot?.liquidacion.totales.montoPropietario || 0,
        ajustes: snapshot?.ajustes.map(ajuste => ({
            id: ajuste.id,
            tipo: ajuste.tipo,
            concepto: ajuste.concepto,
            motivo: ajuste.motivo,
            impactoInquilino: ajuste.impactoInquilino,
            impactoPropietario: ajuste.impactoPropietario,
            creadoPor: ajuste.creadoPor,
            fechaCreacion: ajuste.fechaCreacion
        })) || []
    };
};

// Se ejecuta dentro de la misma transacción que confirma o corrige la
// liquidación. De esta manera una versión nunca puede apuntar a datos a medio
// actualizar ni quedar sin el ajuste que la originó.
export const createLiquidationVoucherSnapshot = async ({
    tx,
    liquidacionId,
    inmobiliariaId,
    usuarioId
}: {
    tx: Prisma.TransactionClient;
    liquidacionId: number;
    inmobiliariaId: number;
    usuarioId: number;
}) => {
    const liquidacion = await tx.liquidacion.findFirst({
        where: { id: liquidacionId, inmobiliariaId },
        include: {
            movimientos: true,
            propietarioPago: true,
            contrato: {
                include: {
                    propiedad: true,
                    inquilinos: { include: { persona: true }, orderBy: { id: 'asc' } },
                    propietarios: { include: { persona: true }, orderBy: { id: 'asc' } }
                }
            },
            pagos: { where: { anuladoEn: null }, orderBy: { id: 'asc' } },
            aplicacionesCredito: {
                include: { creditoInquilino: { include: { ajusteLiquidacion: { select: { concepto: true } } } } },
                orderBy: { id: 'asc' }
            },
            ajustes: {
                include: { creadoPor: { select: { id: true, nombreCompleto: true } }, creditoInquilino: true },
                orderBy: [{ fechaCreacion: 'asc' }, { id: 'asc' }]
            }
        }
    });
    if (!liquidacion) throw new Error('No se encontró la liquidación para emitir el comprobante');

    const [anterior, liquidacionesAnteriores] = await Promise.all([
        tx.comprobanteLiquidacion.findFirst({
            where: { liquidacionId },
            orderBy: { version: 'desc' }
        }),
        tx.liquidacion.findMany({
            where: {
                contratoId: liquidacion.contratoId,
                inmobiliariaId,
                id: { not: liquidacionId },
                estado: { not: 'BORRADOR' }
            },
            include: { pagos: { where: { anuladoEn: null } }, aplicacionesCredito: true },
            orderBy: { periodo: 'asc' }
        })
    ]);

    const snapshotAnterior = readLiquidationVoucherSnapshot(anterior?.fotografia);
    const totalesActuales = totalsOf(liquidacion);
    const deudaAnterior = liquidacionesAnteriores.map(item => {
        const settlement = getTenantSettlement(item);
        return {
            id: item.id,
            periodo: asDate(item.periodo)!,
            neto: asNumber(item.netoACobrar),
            pagado: asNumber(settlement.pagos),
            creditosAplicados: asNumber(settlement.creditosAplicados),
            deuda: asNumber(settlement.saldo),
            moneda: item.moneda,
            estado: item.estado
        };
    }).filter(item => item.deuda > 0);

    const version = (anterior?.version || 0) + 1;
    const snapshot: LiquidationVoucherSnapshot = {
        schemaVersion: 1,
        version,
        emitidoEn: new Date().toISOString(),
        totalesOriginales: snapshotAnterior?.totalesOriginales || totalesActuales,
        liquidacion: {
            id: liquidacion.id,
            estado: liquidacion.estado,
            periodo: asDate(liquidacion.periodo)!,
            fechaCreacion: asDate(liquidacion.fechaCreacion)!,
            fechaConfirmacion: asDate(liquidacion.fechaConfirmacion),
            fechaVencimiento: asDate(liquidacion.fechaVencimiento),
            moneda: liquidacion.moneda,
            totales: totalesActuales,
            pagaHonorarios: liquidacion.pagaHonorarios,
            porcentajeHonorarios: liquidacion.porcentajeHonorarios === null ? null : asNumber(liquidacion.porcentajeHonorarios),
            propiedadDireccion: liquidacion.propiedadDireccion,
            inquilinoNombre: liquidacion.inquilinoNombre,
            propietarioNombre: liquidacion.propietarioNombre
        },
        contrato: {
            id: liquidacion.contrato.id,
            fechaInicio: asDate(liquidacion.contrato.fechaInicio)!,
            fechaFin: asDate(liquidacion.contrato.fechaFin)!,
            fechaProximaActualizacion: asDate(liquidacion.contrato.fechaProximaActualizacion),
            requiereActualizacion: liquidacion.contrato.requiereActualizacion,
            tipoAjuste: liquidacion.contrato.tipoAjuste,
            porcentajeActualizacion: liquidacion.contrato.porcentajeActualizacion === null ? null : asNumber(liquidacion.contrato.porcentajeActualizacion),
            pagaHonorarios: liquidacion.contrato.pagaHonorarios,
            propiedad: {
                id: liquidacion.contrato.propiedad.id,
                direccion: liquidacion.contrato.propiedad.direccion,
                piso: liquidacion.contrato.propiedad.piso || null,
                departamento: liquidacion.contrato.propiedad.departamento || null,
                tipo: liquidacion.contrato.propiedad.tipo,
                partidaInmobiliaria: liquidacion.contrato.propiedad.partidaInmobiliaria || null,
                matricula: liquidacion.contrato.propiedad.matricula || null
            },
            inquilinos: liquidacion.contrato.inquilinos.map(item => ({ id: item.personaId, esPrincipal: item.esPrincipal, persona: selectPersona(item.persona) })),
            propietarios: liquidacion.contrato.propietarios.map(item => ({ id: item.personaId, esPrincipal: item.esPrincipal, persona: selectPersona(item.persona) }))
        },
        movimientos: liquidacion.movimientos.map(item => ({
            id: item.id, tipo: item.tipo, concepto: item.concepto, monto: asNumber(item.monto),
            esParaInmobiliaria: item.esParaInmobiliaria, observaciones: item.observaciones || null
        })),
        pagos: liquidacion.pagos.map(item => ({
            id: item.id, monto: asNumber(item.monto), fechaPago: asDate(item.fechaPago)!, metodoPago: item.metodoPago,
            comprobante: item.comprobante || null, observaciones: item.observaciones || null
        })),
        aplicacionesCredito: liquidacion.aplicacionesCredito.map(item => ({
            id: item.id, monto: asNumber(item.monto), fechaAplicacion: asDate(item.fechaAplicacion)!, creditoInquilinoId: item.creditoInquilinoId,
            concepto: item.creditoInquilino.ajusteLiquidacion.concepto
        })),
        deudaAnterior: {
            totalDeuda: deudaAnterior.reduce((total, item) => total + item.deuda, 0),
            moneda: deudaAnterior[0]?.moneda || liquidacion.moneda,
            detalle: deudaAnterior
        },
        ajustes: liquidacion.ajustes.map(item => ({
            id: item.id,
            tipo: item.tipo,
            concepto: item.concepto,
            motivo: item.motivo,
            monto: asNumber(item.monto),
            impactoInquilino: asNumber(item.impactoInquilino),
            impactoPropietario: asNumber(item.impactoPropietario),
            fechaCreacion: asDate(item.fechaCreacion)!,
            creadoPor: item.creadoPor,
            creditoInquilino: item.creditoInquilino ? {
                id: item.creditoInquilino.id,
                saldoPendiente: asNumber(item.creditoInquilino.saldoPendiente),
                estado: item.creditoInquilino.estado,
                destino: item.creditoInquilino.destino
            } : null
        }))
    };

    return tx.comprobanteLiquidacion.create({
        data: { liquidacionId, version, fotografia: snapshot as unknown as Prisma.InputJsonValue, creadoPorId: usuarioId }
    });
};

// Adaptador para reutilizar los dos generadores PDF. Cuando hay fotografía no
// se lee ningún dato vivo del contrato, de las personas ni de los movimientos.
export const voucherSnapshotToPdfData = (snapshot: LiquidationVoucherSnapshot) => ({
    id: snapshot.liquidacion.id,
    estado: snapshot.liquidacion.estado,
    periodo: snapshot.liquidacion.periodo,
    fechaCreacion: snapshot.liquidacion.fechaCreacion,
    fechaConfirmacion: snapshot.liquidacion.fechaConfirmacion,
    fechaVencimiento: snapshot.liquidacion.fechaVencimiento,
    moneda: snapshot.liquidacion.moneda,
    totalIngresos: snapshot.liquidacion.totales.totalIngresos,
    totalDescuentos: snapshot.liquidacion.totales.totalDescuentos,
    netoACobrar: snapshot.liquidacion.totales.netoACobrar,
    montoPropietario: snapshot.liquidacion.totales.montoPropietario,
    montoHonorarios: snapshot.liquidacion.totales.montoHonorarios,
    montoAlquilerBase: snapshot.liquidacion.totales.montoAlquilerBase,
    pagaHonorarios: snapshot.liquidacion.pagaHonorarios,
    porcentajeHonorarios: snapshot.liquidacion.porcentajeHonorarios,
    propiedadDireccion: snapshot.liquidacion.propiedadDireccion,
    inquilinoNombre: snapshot.liquidacion.inquilinoNombre,
    propietarioNombre: snapshot.liquidacion.propietarioNombre,
    movimientos: snapshot.movimientos,
    pagos: snapshot.pagos,
    aplicacionesCredito: snapshot.aplicacionesCredito.map(item => ({
        ...item,
        creditoInquilino: { ajusteLiquidacion: { concepto: item.concepto } }
    })),
    ajustes: snapshot.ajustes,
    contrato: {
        ...snapshot.contrato,
        propiedad: snapshot.contrato.propiedad,
        inquilinos: snapshot.contrato.inquilinos,
        propietarios: snapshot.contrato.propietarios
    }
});
