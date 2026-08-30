import { TtlCache } from './ttl-cache';
import { cacheTtlFor, msUntilIstHour } from '../../upstream/cache-policy';

describe('TtlCache', () => {
  let now = 1_000_000;
  const clock = () => now;

  beforeEach(() => {
    now = 1_000_000;
  });

  it('serves a fresh entry', () => {
    const cache = new TtlCache<string>(100, clock);
    cache.set('k', 'v', 1000);
    expect(cache.get('k')?.value).toBe('v');
    expect(cache.get('k')?.stale).toBe(false);
  });

  it('stops serving a fresh entry once it expires', () => {
    const cache = new TtlCache<string>(100, clock);
    cache.set('k', 'v', 1000);
    now += 1500;
    expect(cache.get('k')).toBeUndefined();
  });

  /**
   * The point of the stale window: when an upstream is down, a 40-minute-old
   * horoscope beats an error page.
   */
  it('serves a stale entry through the stale window', () => {
    const cache = new TtlCache<string>(100, clock);
    cache.set('k', 'v', 1000, 60_000);
    now += 5000;

    expect(cache.get('k')).toBeUndefined(); // not fresh
    const stale = cache.getAllowStale('k');
    expect(stale?.value).toBe('v');
    expect(stale?.stale).toBe(true);
    expect(stale?.ageMs).toBe(5000);
  });

  it('drops an entry once even the stale window has passed', () => {
    const cache = new TtlCache<string>(100, clock);
    cache.set('k', 'v', 1000, 1000);
    now += 5000;
    expect(cache.getAllowStale('k')).toBeUndefined();
  });

  it('evicts the oldest entry when full', () => {
    const cache = new TtlCache<string>(2, clock);
    cache.set('a', '1', 10_000);
    cache.set('b', '2', 10_000);
    cache.set('c', '3', 10_000);
    expect(cache.stats().size).toBe(2);
    expect(cache.getAllowStale('a')).toBeUndefined();
    expect(cache.getAllowStale('c')?.value).toBe('3');
  });
});

describe('cache policy', () => {
  /**
   * TTLs come from what each source actually means, not from a guessed number.
   */
  it('gives the immutable-ish chart a long TTL and the mutable profile a short one', () => {
    expect(cacheTtlFor('kundli').freshMs).toBeGreaterThan(cacheTtlFor('user').freshMs);
    expect(cacheTtlFor('user').freshMs).toBe(60_000);
  });

  it('expires the horoscope at the next IST midnight', () => {
    // 20:00 UTC on 1 Jan = 01:30 IST on 2 Jan -> 22.5h until the next IST midnight.
    const at = new Date('2026-01-01T20:00:00Z');
    expect(cacheTtlFor('horoscope', at).freshMs).toBe(msUntilIstHour(0, at));
    expect(msUntilIstHour(0, at)).toBeCloseTo(22.5 * 3600_000, -3);
  });

  it('expires the panchang at the next sunrise rather than at midnight', () => {
    const at = new Date('2026-01-01T20:00:00Z'); // 01:30 IST
    const panchang = cacheTtlFor('panchang', at).freshMs;
    const horoscope = cacheTtlFor('horoscope', at).freshMs;
    // 01:30 IST -> 4.5h to 06:00 sunrise, 22.5h to the next midnight.
    expect(panchang).toBeLessThan(horoscope);
    expect(panchang).toBeCloseTo(4.5 * 3600_000, -3);
  });

  it('always gives every source some stale window to fall back on', () => {
    for (const source of ['user', 'kundli', 'horoscope', 'panchang'] as const) {
      expect(cacheTtlFor(source).staleMs).toBeGreaterThan(0);
    }
  });
});
