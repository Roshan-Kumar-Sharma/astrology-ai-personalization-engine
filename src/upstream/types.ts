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

export type UpstreamName = 'user' | 'kundli' | 'horoscope' | 'panchang';

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
}

export function bundleResults(b: ContextBundle): SourceResult<unknown>[] {
  return [b.user, b.kundli, b.horoscope, b.panchang];
}
