import { UpstreamName } from './types';

/**
 * Cache TTLs derived from *domain semantics*, not from a guessed number.
 *
 * This is the point of the file: each astrological data source has a natural
 * validity window, and the cache should express it.
 *
 *  - kundli    : the birth chart itself is immutable after birth. The only
 *                moving part is the dasha *pointer*, whose sub-periods last
 *                months. Long TTL, very long stale window - a chart is never
 *                "wrong enough" to be worth failing a request over.
 *  - horoscope : generated per calendar day -> valid until the next IST midnight.
 *  - panchang  : the panchang day runs sunrise-to-sunrise, not midnight-to-
 *                midnight. We approximate sunrise as 06:00 IST.
 *  - user      : mutable at any moment (the user can change language or tone in
 *                the app and expects the next answer to reflect it). Short TTL.
 */
export interface CacheTtl {
  freshMs: number;
  staleMs: number;
}

const IST_OFFSET_MIN = 330; // UTC+5:30

/** Milliseconds from `now` until the next occurrence of `hourIst`:00 IST. */
export function msUntilIstHour(hourIst: number, now = new Date()): number {
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const target = new Date(istNow);
  target.setUTCHours(hourIst, 0, 0, 0);
  if (target <= istNow) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - istNow.getTime();
}

export function cacheTtlFor(source: UpstreamName, now = new Date()): CacheTtl {
  switch (source) {
    case 'kundli':
      // 6h fresh: bounded so a dasha transition is picked up the same day.
      return { freshMs: 6 * 60 * 60_000, staleMs: 24 * 60 * 60_000 };
    case 'horoscope':
      return { freshMs: msUntilIstHour(0, now), staleMs: 12 * 60 * 60_000 };
    case 'panchang':
      return { freshMs: msUntilIstHour(6, now), staleMs: 12 * 60 * 60_000 };
    case 'user':
      return { freshMs: 60_000, staleMs: 10 * 60_000 };
  }
}

/**
 * How badly does losing this source hurt?
 *
 * Used by the confidence calculator: losing the kundli guts a career answer,
 * losing the panchang barely matters unless the question is about today.
 */
export const SOURCE_CRITICALITY: Record<UpstreamName, number> = {
  user: 0.15,
  kundli: 0.45,
  horoscope: 0.3,
  panchang: 0.1,
};
