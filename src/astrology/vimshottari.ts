import { Planet } from './zodiac';

/**
 * Vimshottari dasha arithmetic.
 *
 * The single most useful thing an astrologer knows about a "should I change
 * something in the next few months?" question is *where in the current planetary
 * period the person is standing*. Being three months into an 18-year Rahu
 * mahadasha and being in its final sub-period mean opposite things, yet the raw
 * upstream payload ("mahadasha: Rahu, antardasha: Mars") looks identical either
 * way. This module recovers that structure deterministically.
 */

/** Fixed 120-year cycle. Order and durations are invariant in Vimshottari. */
export const DASHA_SEQUENCE: Planet[] = [
  'Ketu',
  'Venus',
  'Sun',
  'Moon',
  'Mars',
  'Rahu',
  'Jupiter',
  'Saturn',
  'Mercury',
];

export const DASHA_YEARS: Record<Planet, number> = {
  Ketu: 7,
  Venus: 20,
  Sun: 6,
  Moon: 10,
  Mars: 7,
  Rahu: 18,
  Jupiter: 16,
  Saturn: 19,
  Mercury: 17,
};

export const TOTAL_CYCLE_YEARS = 120;

export function isDashaLord(name: string): name is Planet {
  return (DASHA_SEQUENCE as string[]).includes(capitalize(name));
}

export function normalizePlanet(name: string): Planet | undefined {
  const c = capitalize(name.trim());
  return (DASHA_SEQUENCE as string[]).includes(c) ? (c as Planet) : undefined;
}

/**
 * Antardashas within a mahadasha run in the same cyclic order, beginning with
 * the mahadasha lord itself.
 */
export function antardashaSequence(mahadasha: Planet): Planet[] {
  const start = DASHA_SEQUENCE.indexOf(mahadasha);
  return Array.from({ length: 9 }, (_, i) => DASHA_SEQUENCE[(start + i) % 9]);
}

/** Antardasha length in years: mdYears x adYears / 120. */
export function antardashaYears(mahadasha: Planet, antardasha: Planet): number {
  return (DASHA_YEARS[mahadasha] * DASHA_YEARS[antardasha]) / TOTAL_CYCLE_YEARS;
}

export interface DashaPosition {
  mahadasha: Planet;
  antardasha: Planet;
  mahadashaYears: number;
  antardashaMonths: number;
  /** 1-based index of the antardasha within the mahadasha (1..9). */
  antardashaIndex: number;
  /** True when this is the closing sub-period of the mahadasha. */
  isFinalAntardasha: boolean;
  /** True for the opening sub-period. */
  isOpeningAntardasha: boolean;
  /** The lord whose mahadasha begins next. */
  nextMahadasha: Planet;
  /** The next antardasha within this mahadasha, if any. */
  nextAntardasha?: Planet;
  /**
   * Fraction of the mahadasha elapsed at the *start* and *end* of the current
   * antardasha. Expressed as a range because the upstream payload gives no
   * dates - we know which sub-period, not how far into it.
   */
  chapterProgress: { fromPct: number; toPct: number };
  /** Where the person is standing, in plain language. */
  phase: 'opening' | 'early' | 'middle' | 'late' | 'closing';
}

export function locateDasha(
  mahadashaRaw: string,
  antardashaRaw: string,
): DashaPosition | undefined {
  const mahadasha = normalizePlanet(mahadashaRaw);
  const antardasha = normalizePlanet(antardashaRaw);
  if (!mahadasha || !antardasha) return undefined;

  const seq = antardashaSequence(mahadasha);
  const idx = seq.indexOf(antardasha);
  if (idx < 0) return undefined;

  const mdYears = DASHA_YEARS[mahadasha];
  const elapsedBefore = seq
    .slice(0, idx)
    .reduce((sum, p) => sum + antardashaYears(mahadasha, p), 0);
  const currentYears = antardashaYears(mahadasha, antardasha);

  const fromPct = round1((elapsedBefore / mdYears) * 100);
  const toPct = round1(((elapsedBefore + currentYears) / mdYears) * 100);
  const midPct = (fromPct + toPct) / 2;

  return {
    mahadasha,
    antardasha,
    mahadashaYears: mdYears,
    antardashaMonths: round1(currentYears * 12),
    antardashaIndex: idx + 1,
    isFinalAntardasha: idx === 8,
    isOpeningAntardasha: idx === 0,
    nextMahadasha: DASHA_SEQUENCE[(DASHA_SEQUENCE.indexOf(mahadasha) + 1) % 9],
    nextAntardasha: idx < 8 ? seq[idx + 1] : undefined,
    chapterProgress: { fromPct, toPct },
    phase:
      idx === 0
        ? 'opening'
        : idx === 8
          ? 'closing'
          : midPct < 35
            ? 'early'
            : midPct < 70
              ? 'middle'
              : 'late',
  };
}

/**
 * The 27 nakshatras cycle through the same nine dasha lords, three times over.
 * This lets us connect today's panchang to the user's running dasha - if the
 * Moon is transiting a nakshatra ruled by the user's own dasha lord, that day
 * is unusually "live" for them. It is the cleanest bridge between a global
 * daily almanac and one individual's chart.
 */
export const NAKSHATRAS: string[] = [
  'Ashwini',
  'Bharani',
  'Krittika',
  'Rohini',
  'Mrigashira',
  'Ardra',
  'Punarvasu',
  'Pushya',
  'Ashlesha',
  'Magha',
  'Purva Phalguni',
  'Uttara Phalguni',
  'Hasta',
  'Chitra',
  'Swati',
  'Vishakha',
  'Anuradha',
  'Jyeshtha',
  'Mula',
  'Purva Ashadha',
  'Uttara Ashadha',
  'Shravana',
  'Dhanishta',
  'Shatabhisha',
  'Purva Bhadrapada',
  'Uttara Bhadrapada',
  'Revati',
];

export function nakshatraLord(nakshatra: string): Planet | undefined {
  const i = NAKSHATRAS.findIndex((n) => n.toLowerCase() === nakshatra.trim().toLowerCase());
  return i < 0 ? undefined : DASHA_SEQUENCE[i % 9];
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
