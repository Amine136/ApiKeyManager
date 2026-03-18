/**
 * Simple in-memory TTL cache.
 * Each entry expires after `ttlMs` milliseconds.
 * Use `invalidate()` to clear on writes.
 */

interface CacheEntry<T> {
    value: T;
    timer: ReturnType<typeof setTimeout>;
}

export class TTLCache<T> {
    private store = new Map<string, CacheEntry<T>>();
    private ttlMs: number;

    constructor(ttlMs: number) {
        this.ttlMs = ttlMs;
    }

    get(key: string): T | undefined {
        return this.store.get(key)?.value;
    }

    set(key: string, value: T): void {
        // Clear existing timer if key exists
        const existing = this.store.get(key);
        if (existing) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            this.store.delete(key);
        }, this.ttlMs);
        if (timer.unref) timer.unref();

        this.store.set(key, { value, timer });
    }

    /** Invalidate a single key or the entire cache. */
    invalidate(key?: string): void {
        if (key) {
            const entry = this.store.get(key);
            if (entry) {
                clearTimeout(entry.timer);
                this.store.delete(key);
            }
        } else {
            for (const entry of this.store.values()) {
                clearTimeout(entry.timer);
            }
            this.store.clear();
        }
    }

    get size(): number {
        return this.store.size;
    }
}
