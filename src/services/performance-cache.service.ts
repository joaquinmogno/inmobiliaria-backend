type CacheEntry<T> = { value: T; expiresAt: number };

const cache = new Map<string, CacheEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

export async function cached<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const hit = cache.get(key) as CacheEntry<T> | undefined;
    if (hit && hit.expiresAt > Date.now()) return hit.value;
    const pending = inFlight.get(key) as Promise<T> | undefined;
    if (pending) return pending;

    const promise = loader().then(value => {
        cache.set(key, { value, expiresAt: Date.now() + ttlMs });
        return value;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

export function invalidatePerformanceCache(inmobiliariaId: number) {
    const prefix = `inmobiliaria:${inmobiliariaId}:`;
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
}
