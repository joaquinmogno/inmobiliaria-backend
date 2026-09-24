import { z } from 'zod';
import { AppError } from '../errors/app-error';

export const optimisticVersionSchema = z.coerce.number().int().positive('La versión del registro es inválida');

export const STALE_WRITE_CODE = 'STALE_WRITE';
export const STALE_WRITE_MESSAGE = 'No se guardaron tus cambios porque otro usuario modificó este registro. Cerrá y volvé a abrir la ficha para comparar la información vigente.';

export const assertOptimisticUpdate = (
    updatedRows: number,
    submittedVersion: number,
    currentVersion?: number
) => {
    if (updatedRows > 0) return;

    throw new AppError(STALE_WRITE_MESSAGE, {
        statusCode: 409,
        code: STALE_WRITE_CODE,
        details: {
            submittedVersion,
            currentVersion,
            action: 'reload'
        }
    });
};
