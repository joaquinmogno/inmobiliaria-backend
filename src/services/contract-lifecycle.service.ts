import { EstadoContrato, Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { invalidatePerformanceCache } from './performance-cache.service';
import { argentinaTodayAsDate } from '../utils/argentina-date';

type TxClient = Prisma.TransactionClient;

export function dateOnlyToday(now = new Date()) {
    return argentinaTodayAsDate(now);
}

export function getContractStateForDates(fechaInicio: Date, fechaFin: Date, now = new Date()): EstadoContrato {
    const today = dateOnlyToday(now);
    if (fechaFin < today) return EstadoContrato.FINALIZADO;
    if (fechaInicio > today) return EstadoContrato.PROGRAMADO;
    return EstadoContrato.ACTIVO;
}

export async function syncPropertyOccupancy(tx: TxClient, propertyIds: number[], now = new Date()) {
    const uniquePropertyIds = [...new Set(propertyIds)];
    if (!uniquePropertyIds.length) return;

    const today = dateOnlyToday(now);
    for (const propertyId of uniquePropertyIds) {
        const activeContract = await tx.contrato.findFirst({
            where: {
                propiedadId: propertyId,
                estado: EstadoContrato.ACTIVO,
                fechaInicio: { lte: today },
                fechaFin: { gte: today }
            },
            select: { id: true }
        });
        await tx.propiedad.updateMany({
            where: {
                id: propertyId,
                estado: { notIn: ['INACTIVO', activeContract ? 'ALQUILADO' : 'DISPONIBLE'] }
            },
            data: {
                estado: activeContract ? 'ALQUILADO' : 'DISPONIBLE',
                version: { increment: 1 }
            }
        });
    }
}

export async function syncContractLifecycle(inmobiliariaId?: number, now = new Date()) {
    const today = dateOnlyToday(now);
    const agencyFilter = inmobiliariaId ? { inmobiliariaId } : {};

    const [toFinalize, toActivate] = await Promise.all([
        prisma.contrato.findMany({
            where: {
                ...agencyFilter,
                estado: { in: [EstadoContrato.ACTIVO, EstadoContrato.PROGRAMADO] },
                fechaFin: { lt: today }
            },
            select: { id: true, inmobiliariaId: true, propiedadId: true, estado: true }
        }),
        prisma.contrato.findMany({
            where: {
                ...agencyFilter,
                estado: EstadoContrato.PROGRAMADO,
                fechaInicio: { lte: today },
                fechaFin: { gte: today }
            },
            select: { id: true, inmobiliariaId: true, propiedadId: true, estado: true }
        })
    ]);

    if (!toFinalize.length && !toActivate.length) {
        return { activated: 0, finalized: 0, agencyIds: [] as number[] };
    }

    const result = await prisma.$transaction(async tx => {

        if (toFinalize.length) {
            await tx.contrato.updateMany({
                where: {
                    id: { in: toFinalize.map(contract => contract.id) },
                    estado: { in: [EstadoContrato.ACTIVO, EstadoContrato.PROGRAMADO] }
                },
                data: { estado: EstadoContrato.FINALIZADO, version: { increment: 1 } }
            });
        }
        if (toActivate.length) {
            await tx.contrato.updateMany({
                where: { id: { in: toActivate.map(contract => contract.id) }, estado: EstadoContrato.PROGRAMADO },
                data: { estado: EstadoContrato.ACTIVO, version: { increment: 1 } }
            });
        }

        const transitions = [
            ...toFinalize.map(contract => ({ ...contract, nextState: EstadoContrato.FINALIZADO })),
            ...toActivate.map(contract => ({ ...contract, nextState: EstadoContrato.ACTIVO }))
        ];
        if (transitions.length) {
            await tx.auditLog.createMany({
                data: transitions.map(contract => ({
                    inmobiliariaId: contract.inmobiliariaId,
                    accion: 'CAMBIAR_ESTADO_CONTRATO_AUTOMATICO',
                    entidad: 'Contrato',
                    entidadId: contract.id,
                    detalle: JSON.stringify({
                        estado: { anterior: contract.estado, nuevo: contract.nextState }
                    })
                }))
            });
            await syncPropertyOccupancy(tx, transitions.map(contract => contract.propiedadId), now);
        }

        return {
            activated: toActivate.length,
            finalized: toFinalize.length,
            agencyIds: [...new Set(transitions.map(contract => contract.inmobiliariaId))]
        };
    });

    result.agencyIds.forEach(invalidatePerformanceCache);
    return result;
}
