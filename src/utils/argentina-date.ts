export const ARGENTINA_TIME_ZONE = 'America/Argentina/Buenos_Aires';

const dateOnlyPattern = /^(\d{4})-(\d{2})-(\d{2})$/;

function argentinaParts(date: Date) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: ARGENTINA_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)?.value || '';
    return { year: value('year'), month: value('month'), day: value('day') };
}

export function argentinaDateOnly(now = new Date()) {
    const { year, month, day } = argentinaParts(now);
    return `${year}-${month}-${day}`;
}

export function argentinaYearMonth(now = new Date()) {
    return argentinaDateOnly(now).slice(0, 7);
}

/** Convierte YYYY-MM-DD a medianoche UTC para persistir/comparar columnas DATE. */
export function parseDateOnly(value: string) {
    const match = dateOnlyPattern.exec(value);
    if (!match) throw new Error('Fecha inválida; se esperaba YYYY-MM-DD');
    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new Error('Fecha civil inválida');
    }
    return date;
}

export function argentinaTodayAsDate(now = new Date()) {
    return parseDateOnly(argentinaDateOnly(now));
}

/**
 * Las fechas de operaciones financieras se manejan como fechas civiles
 * argentinas. Un movimiento futuro no puede afectar anticipadamente la deuda
 * ni la caja; los cheques diferidos requieren su propio flujo de acreditación.
 */
export function assertOperationalDateIsNotFuture(
    value: Date,
    label = 'La fecha de la operación',
    now = new Date()
) {
    if (value > argentinaTodayAsDate(now)) {
        throw Object.assign(new Error(`${label} no puede ser futura`), {
            statusCode: 422,
            code: 'FUTURE_OPERATION_DATE'
        });
    }
}

export function addCalendarDays(date: Date, days: number) {
    const result = new Date(date.getTime());
    result.setUTCDate(result.getUTCDate() + days);
    return result;
}

/** Límites UTC del día calendario argentino, útiles para filtrar timestamps. */
export function argentinaDayRange(value: string) {
    const civilDate = parseDateOnly(value);
    const nextDate = addCalendarDays(civilDate, 1).toISOString().slice(0, 10);
    return {
        start: new Date(`${value}T00:00:00-03:00`),
        end: new Date(`${nextDate}T00:00:00-03:00`)
    };
}
