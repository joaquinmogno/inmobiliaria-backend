import { Prisma } from '@prisma/client';

export const INSTALLATION_LOCKS = {
    activeAdministrator: 81726355,
    usersAndRoles: 81726356,
    monthlyLiquidations: 81726357
} as const;

export async function acquireInstallationLock(
    tx: Prisma.TransactionClient,
    lockNamespace: number,
    inmobiliariaId: number
) {
    await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(
            CAST(${lockNamespace} AS integer),
            CAST(${inmobiliariaId} AS integer)
        )
    `;
}
