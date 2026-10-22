/** Mantiene el día pactado y lo limita al último día de meses más cortos. */
export function addContractMonths(date: Date, months: number): Date {
    if (!Number.isInteger(months)) throw new Error('La frecuencia debe ser un número entero de meses');
    const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
    const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
    return new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(date.getUTCDate(), lastDay)));
}

/** Avanza desde el vencimiento programado, no desde el día en que el operador cargó el nuevo alquiler. */
export function nextContractUpdateDate(scheduled: Date, frequencyMonths: number, appliedPeriod: Date): Date {
    if (!Number.isInteger(frequencyMonths) || frequencyMonths < 1 || frequencyMonths > 120) {
        throw new Error('La frecuencia debe estar entre 1 y 120 meses');
    }
    const difference = (appliedPeriod.getUTCFullYear() - scheduled.getUTCFullYear()) * 12
        + appliedPeriod.getUTCMonth() - scheduled.getUTCMonth();
    const cycles = Math.max(1, Math.floor(difference / frequencyMonths) + 1);
    return addContractMonths(scheduled, cycles * frequencyMonths);
}
