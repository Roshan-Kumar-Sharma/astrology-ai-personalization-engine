/** Shapes returned by the existing MyNaksh backend services. */

export interface UserProfile {
  id: string;
  name: string;
  /** ISO-639-1 code. en | hi | mr | ta | te | pa ... */
  language: string;
  subscription: 'free' | 'premium' | string;
  tonePreference: string;
  birthDetails: {
    date: string; // YYYY-MM-DD
    /** HH:mm. May be absent or approximate - see BirthTimeReliability. */
    time?: string;
    place: string;
    /** Optional: how the birth time was obtained. Drives confidence. */
    timeAccuracy?: 'exact' | 'approximate' | 'unknown';
  };
}

export interface HouseInfo {
  lord: string;
  strength: 'Strong' | 'Average' | 'Weak' | string;
}

export interface Kundli {
  lagna: string;
  moonSign: string;
  currentDasha: {
    mahadasha: string;
    antardasha: string;
    /** Optional ISO dates; when absent we estimate from the Vimshottari cycle. */
    antardashaStart?: string;
    antardashaEnd?: string;
  };
  houses: Record<string, HouseInfo>;
}

export interface Horoscope {
  career: string;
  finance: string;
  health: string;
  relationship: string;
  /** Optional: the date this horoscope was generated for. */
  date?: string;
}

export interface Panchang {
  date: string;
  tithi: string;
  nakshatra: string;
  yoga: string;
  karana: string;
}

/**
 * Current sidereal positions of the slow-moving planets - the ones whose sign
 * changes are rare enough to characterise a season rather than a day.
 *
 * Only these four are carried. The Sun, Moon, Mercury, Venus and Mars change
 * sign within days or weeks; that rhythm belongs to the panchang, which already
 * carries the Moon's position as the nakshatra. Saturn, Jupiter and the nodes
 * are the transits classical gochar actually reads.
 */
export interface Transits {
  date: string;
  positions: Record<'Saturn' | 'Jupiter' | 'Rahu' | 'Ketu', TransitPositionDto>;
}

export interface TransitPositionDto {
  sign: string;
  /** Sidereal degree within the sign, 0-30. */
  degree: number;
  retrograde?: boolean;
}

export type UpstreamName = 'user' | 'kundli' | 'horoscope' | 'panchang' | 'transit';

export type FetchOutcome = 'ok' | 'cached' | 'stale' | 'failed' | 'skipped';

/** Per-source result, carrying enough metadata to reason about trust. */
export interface SourceResult<T> {
  source: UpstreamName;
  outcome: FetchOutcome;
  data?: T;
  error?: string;
  latencyMs: number;
  /** Age of the data in ms when served from cache. */
  ageMs?: number;
  attempts: number;
}

/** Everything the engine knows about a user at request time. */
export interface ContextBundle {
  user: SourceResult<UserProfile>;
  kundli: SourceResult<Kundli>;
  horoscope: SourceResult<Horoscope>;
  panchang: SourceResult<Panchang>;
  transit: SourceResult<Transits>;
}

export function bundleResults(b: ContextBundle): SourceResult<unknown>[] {
  return [b.user, b.kundli, b.horoscope, b.panchang, b.transit];
}
