export const MAX_PAGE_SIZE = 100;
export const MAX_PAGE_NUMBER = 10_000;

export function parsePagination(page: unknown, limit: unknown, defaultLimit = 25) {
  const parsedPage = Number.parseInt(String(page ?? '1'), 10);
  const parsedLimit = Number.parseInt(String(limit ?? defaultLimit), 10);
  const safePage = Number.isFinite(parsedPage) && parsedPage > 0
    ? Math.min(parsedPage, MAX_PAGE_NUMBER)
    : 1;
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, MAX_PAGE_SIZE)
    : defaultLimit;

  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit
  };
}
