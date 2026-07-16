export function parsePagination(page: unknown, limit: unknown, defaultLimit = 25) {
  const parsedPage = Number.parseInt(String(page ?? '1'), 10);
  const parsedLimit = Number.parseInt(String(limit ?? defaultLimit), 10);
  const safePage = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;
  const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(parsedLimit, 100)
    : defaultLimit;

  return {
    page: safePage,
    limit: safeLimit,
    skip: (safePage - 1) * safeLimit
  };
}
