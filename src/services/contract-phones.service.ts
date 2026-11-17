import type { Prisma } from '@prisma/client';
import { AppError } from '../errors/app-error';
import { assertOptimisticUpdate } from '../utils/optimistic-lock';
import { assertPersonIdentityAvailable, normalizePersonPhone } from '../utils/person-identity';
import type { ContractPhoneUpdate } from '../validation/contratos.schemas';
import { auditService } from './audit.service';

export async function updateContractPhones(tx: Prisma.TransactionClient, params: {
    contratoId: number;
    inmobiliariaId: number;
    usuarioId: number;
    updates: ContractPhoneUpdate[];
}) {
    const { contratoId, inmobiliariaId, usuarioId, updates } = params;
    if (!updates.length) return [];

    const people = await tx.persona.findMany({
        where: {
            id: { in: updates.map(update => update.personaId) },
            inmobiliariaId,
            OR: [
                { contratosPropietario: { some: { contratoId } } },
                { contratosInquilino: { some: { contratoId } } }
            ]
        },
        select: { id: true, version: true, telefono: true }
    });
    if (people.length !== updates.length) {
        throw new AppError('Solo podés editar teléfonos de propietarios e inquilinos de este contrato', {
            statusCode: 400, code: 'INVALID_CONTRACT_CONTACT'
        });
    }

    const changes: Array<{ personaId: number; anterior: string | null; nuevo: string | null }> = [];
    for (const update of updates) {
        const person = people.find(item => item.id === update.personaId)!;
        if (person.version !== update.version) assertOptimisticUpdate(0, update.version, person.version);
        if (person.telefono === update.telefono) continue;

        await assertPersonIdentityAvailable(tx, inmobiliariaId, { telefono: update.telefono }, person.id);
        const result = await tx.persona.updateMany({
            where: { id: person.id, inmobiliariaId, version: update.version },
            data: {
                telefono: update.telefono,
                telefonoNormalizado: update.telefono ? normalizePersonPhone(update.telefono) : null,
                actualizadoPorId: usuarioId,
                version: { increment: 1 }
            }
        });
        assertOptimisticUpdate(result.count, update.version);
        await auditService.log({
            usuarioId, inmobiliariaId, accion: 'ACTUALIZAR_PERSONA', entidad: 'Persona', entidadId: person.id,
            detalle: JSON.stringify({
                telefono: { anterior: person.telefono, nuevo: update.telefono },
                origen: 'Edición de contrato', contratoId
            })
        }, tx);
        changes.push({ personaId: person.id, anterior: person.telefono, nuevo: update.telefono });
    }
    return changes;
}
