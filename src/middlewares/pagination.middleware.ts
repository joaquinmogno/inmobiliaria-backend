import { RequestHandler } from 'express';
import { MAX_PAGE_NUMBER, parsePagination } from '../utils/pagination';

const POSITIVE_INTEGER = /^[1-9]\d*$/;

type PaginationOptions = {
    pageParam?: string;
    limitParam?: string;
    localsKey?: string;
};

export const withPagination = (
    defaultLimit = 25,
    options: PaginationOptions = {}
): RequestHandler => (req, res, next) => {
    const pageParam = options.pageParam || 'page';
    const limitParam = options.limitParam || 'limit';
    const localsKey = options.localsKey || 'pagination';
    const rawPage = req.query[pageParam];
    const rawLimit = req.query[limitParam];

    const invalidPage = rawPage !== undefined
        && (typeof rawPage !== 'string' || !POSITIVE_INTEGER.test(rawPage) || Number(rawPage) > MAX_PAGE_NUMBER);
    const invalidLimit = rawLimit !== undefined
        && (typeof rawLimit !== 'string' || !POSITIVE_INTEGER.test(rawLimit));

    if (invalidPage || invalidLimit) {
        return res.status(400).json({
            message: `La página y el límite deben ser enteros positivos; la página máxima es ${MAX_PAGE_NUMBER}`,
            code: 'INVALID_PAGINATION'
        });
    }

    res.locals[localsKey] = parsePagination(rawPage, rawLimit, defaultLimit);
    next();
};
