import { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { getContractOutstandingObligations } from './contract-financial-integrity.service';
import { getOwnerPaymentSettlement, getTenantSettlement } from './tenant-credit.service';
import type { ContractRescissionInput, KeyDeliveryInput } from '../validation/contratos.schemas';
import { createHash } from 'crypto';

type Tx = Prisma.TransactionClient;

export async function getRescissionContext(tx: Tx, contractId: number, inmobiliariaId: number) {
    const contract = await tx.contrato.findFirst({
        where: { id: contractId, inmobiliariaId },
        include: {
            propiedad: true,
            inquilinos: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
            propietarios: { include: { persona: true }, orderBy: { esPrincipal: 'desc' } },
            liquidaciones: {
                orderBy: { periodo: 'desc' },
                include: { pagos: { where: { anuladoEn: null }, orderBy: { fechaPago: 'asc' } }, aplicacionesCredito: true, pagosPropietario: { where: { anuladoEn: null }, orderBy: { fechaPago: 'asc' } } }
            },
            actasRescision: { select: { id: true, version: true, fechaEmision: true, motivoRevision: true }, orderBy: { version: 'desc' } },
            actasEntregaLlaves: { select: { id: true, version: true, fechaEmision: true, datos: true }, orderBy: { version: 'desc' } },
            adjuntos: { where: { tipo: { in: ['ACTA_RESCISION_FIRMADA', 'ACTA_LLAVES_FIRMADA'] } }, select: { id: true, tipo: true, versionDocumento: true, rutaArchivo: true, nombreArchivo: true } }
        }
    });
    if (!contract) throw new AppError('Contrato no encontrado', { statusCode: 404, code: 'CONTRACT_NOT_FOUND' });
    const saldosRegistrados = await getContractOutstandingObligations(tx, contractId);
    const liquidaciones = contract.liquidaciones.map(liquidacion => {
        const settlement = getTenantSettlement(liquidacion);
        const ownerSettlement = getOwnerPaymentSettlement(liquidacion);
        return {
            id: liquidacion.id, periodo: liquidacion.periodo.toISOString().slice(0, 10), estado: liquidacion.estado,
            moneda: liquidacion.moneda, totalInquilino: liquidacion.netoACobrar.toFixed(2),
            pagadoInquilino: settlement.totalAplicado.toFixed(2), saldoInquilino: settlement.saldo.toFixed(2),
            totalPropietario: liquidacion.montoPropietario.toFixed(2), pagadoPropietario: ownerSettlement.pagado.toFixed(2),
            pagos: liquidacion.pagos.map(pago => ({ fecha: pago.fechaPago.toISOString().slice(0, 10), importe: pago.monto.toFixed(2), metodo: pago.metodoPago })),
            pagosPropietario: liquidacion.pagosPropietario.map(pago => ({ fecha: pago.fechaPago.toISOString().slice(0, 10), importe: pago.monto.toFixed(2), metodo: pago.metodoPago }))
        };
    });
    return {
        contrato: {
            id: contract.id, version: contract.version, estado: contract.estado, fechaInicio: contract.fechaInicio.toISOString().slice(0, 10),
            fechaFin: contract.fechaFin.toISOString().slice(0, 10), fechaRescision: contract.fechaRescision?.toISOString().slice(0, 10) ?? null,
            fechaEntregaLlaves: contract.fechaEntregaLlaves?.toISOString().slice(0, 10) ?? null,
            moneda: contract.moneda, direccion: contract.propiedad.direccion,
            piso: contract.propiedad.piso, departamento: contract.propiedad.departamento,
            inquilinos: contract.inquilinos.map(item => ({ nombre: item.persona.nombreCompleto, dni: item.persona.dni })),
            propietarios: contract.propietarios.map(item => ({ nombre: item.persona.nombreCompleto, dni: item.persona.dni }))
        },
        saldosRegistrados, liquidaciones, actas: contract.actasRescision,
        actasLlaves: contract.actasEntregaLlaves,
        copiasFirmadas: contract.adjuntos.filter(item => item.tipo === 'ACTA_RESCISION_FIRMADA'),
        copiasLlavesFirmadas: contract.adjuntos.filter(item => item.tipo === 'ACTA_LLAVES_FIRMADA')
    };
}

export function buildKeyDeliverySnapshot(context: Awaited<ReturnType<typeof getRescissionContext>>, input: KeyDeliveryInput) {
    return {
        contrato: context.contrato,
        entrega: {
            fechaEntregaLlaves: input.fechaEntregaLlaves,
            horaEntrega: input.horaEntrega ?? null,
            cantidadLlaves: input.cantidadLlaves,
            receptorNombre: input.receptorNombre,
            estadoInmueble: input.estadoInmueble,
            observaciones: input.observaciones ?? null,
            inmuebleDesocupado: true
        },
        saldosAlEntregar: context.saldosRegistrados,
        aviso: 'El acta acredita la entrega del inmueble y las llaves. No cancela saldos, servicios, multas ni depósito.'
    };
}

export type KeyDeliverySnapshot = ReturnType<typeof buildKeyDeliverySnapshot>;
export const keyDeliveryPreviewHash = (snapshot: KeyDeliverySnapshot) =>
    createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');

export function buildRescissionSnapshot(context: Awaited<ReturnType<typeof getRescissionContext>>, input: ContractRescissionInput) {
    return {
        contrato: context.contrato,
        declaracion: {
            tipoCierre: input.tipoCierre, sinReclamosConfirmado: true,
            serviciosSaldadosConfirmados: true, depositoResueltoConfirmado: true,
            motivo: input.motivo, motivoRevision: input.motivoRevision ?? null, fechaRescision: input.fechaRescision, llavesEntregadas: input.llavesEntregadas,
            fechaEntregaLlaves: input.llavesEntregadas ? input.fechaEntregaLlaves : null,
            cantidadLlaves: input.cantidadLlaves, estadoInmueble: input.estadoInmueble,
            observaciones: input.observaciones ?? null, multaImporte: input.multaImporte.toFixed(2),
            multaResponsable: input.multaImporte > 0 ? input.multaResponsable : null,
            depositoADevolver: input.depositoADevolver.toFixed(2), depositoRetenido: input.depositoRetenido.toFixed(2),
            motivoRetencion: input.motivoRetencion ?? null,
            pendientesManuales: input.pendientesManuales.map(item => ({ ...item, importe: item.importe.toFixed(2) }))
        },
        saldosRegistrados: context.saldosRegistrados,
        liquidacionesAlEmitir: context.liquidaciones,
        aviso: 'El cierre documenta la declaración de las partes. Los importes manuales no registran cobros ni pagos.'
    };
}

export type RescissionSnapshot = ReturnType<typeof buildRescissionSnapshot>;

export function rescissionPreviewHash(snapshot: RescissionSnapshot) {
    return createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}
