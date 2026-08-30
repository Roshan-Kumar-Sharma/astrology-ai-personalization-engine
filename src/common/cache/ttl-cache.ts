/**
 * In-memory TTL cache with stale-while-revalidate semantics.
 *
 * Why stale-while-revalidate matters here: an astrology answer built from a
 * 30-minute-old horoscope is vastly better than an error page. When an upstream
 * is down we would rather serve a stale entry and mark the response's confidence
 * down than fail the user's question outright.
 */
export interface CacheEntry<T> {
  value: T;
  storedAt: number;
  /** Hard expiry: after this the value is evicted. */
  expiresAt: number;
  /** Soft expiry: after this the value is "stale" but still servable. */
  freshUntil: number;
}

export interface CacheGetResult<T> {
  value: T;
  stale: boolean;
  ageMs: number;
}

export interface CacheStats {
  hits: number;
  staleHits: number;
  misses: number;
  size: number;
}

export class TtlCache<T = unknown> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private staleHits = 0;
  private misses = 0;

  constructor(
    private readonly maxEntries = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * @param freshMs how long the entry is considered fresh
   * @param staleMs additional window during which the entry may be served stale
   */
  set(key: string, value: T, freshMs: number, staleMs = 0): void {
    if (this.store.size >= this.maxEntries) this.evictOldest();
    const t = this.now();
    this.store.set(key, {
      value,
      storedAt: t,
      freshUntil: t + freshMs,
      expiresAt: t + freshMs + staleMs,
    });
  }

  /** Returns a fresh entry only. */
  get(key: string): CacheGetResult<T> | undefined {
    const res = this.getAllowStale(key);
    if (!res || res.stale) {
      if (res?.stale) {
        // A stale-only hit is a miss for the "fresh" path; do not double count.
        this.hits -= 1;
        this.staleHits += 1;
        this.misses += 1;
      }
      return undefined;
    }
    return res;
  }

  /** Returns fresh *or* stale entries; caller decides how to treat staleness. */
  getAllowStale(key: string): CacheGetResult<T> | undefined {
    const entry = this.store.get(key);
    const t = this.now();
    if (!entry) {
      this.misses += 1;
      return undefined;
    }
    if (t > entry.expiresAt) {
      this.store.delete(key);
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    return { value: entry.value, stale: t > entry.freshUntil, ageMs: t - entry.storedAt };
  }

  delete(key: string): void {
    this.store.delete(key);
  }

  clear(): void {
    this.store.clear();
    this.hits = this.staleHits = this.misses = 0;
  }

  stats(): CacheStats {
    return {
      hits: this.hits,
      staleHits: this.staleHits,
      misses: this.misses,
      size: this.store.size,
    };
  }

  private evictOldest(): void {
    // Map preserves insertion order; the first key is the oldest write.
    const oldest = this.store.keys().next();
    if (!oldest.done) this.store.delete(oldest.value);
  }
}
