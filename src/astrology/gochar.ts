import { Dignity, dignityOf, signIndex, Sign } from './zodiac';

/**
 * Gochar (transit) arithmetic. Pure functions, no I/O.
 *
 * The natal chart says what a person *is*; the dasha says which chapter they
 * are in; the gochar says what the sky is doing to that chart *right now*. Of
 * the three, transits are the one an Indian user is most likely to ask about
 * by name - "is my Sade Sati over?" is a question the app will receive daily.
 *
 * Only the slow movers are modelled: Saturn (~2.5 years a sign), Jupiter (~1
 * year), and the lunar nodes Rahu/Ketu (~1.5 years). Faster planets change
 * sign within weeks and belong to the daily almanac; the panchang already
 * carries the Moon's position as the nakshatra. Slow transits are the ones
 * that can characterise a month, a quarter or a year - which is exactly the
 * horizon band where the panchang has nothing to say.
 *
 * Everything here is counted from the natal **Moon sign**, as classical gochar
 * is. That is not a stylistic choice: the Moon sign survives a birth time that
 * is wrong by hours, so these facts remain sound for a user whose houses have
 * been suppressed. House-relative transits are a separate, lagna-dependent
 * computation and are gated accordingly.
 */

export type TransitPlanet = 'Saturn' | 'Jupiter' | 'Rahu' | 'Ketu';

export interface TransitPosition {
  sign: string;
  /** Sidereal degree within the sign, 0-30. */
  degree: number;
}

/**
 * Mean sidereal period per sign, in months. From the orbital periods:
 * Saturn 29.457 y, Jupiter 11.862 y, the nodes 18.613 y - each divided by 12.
 * Mean motion ignores retrograde loops, so the "months remaining" figures are
 * estimates and are worded as such wherever they are rendered.
 */
export const MONTHS_PER_SIGN: Record<TransitPlanet, number> = {
  Saturn: 29.5,
  Jupiter: 11.9,
  Rahu: 18.6,
  Ketu: 18.6,
};

export interface SignProgress {
  /** How far through the current sign, 0-100. */
  pct: number;
  /** Approximate months until the planet leaves this sign, by mean motion. */
  monthsRemaining: number;
}

/**
 * Where a planet stands within its current sign.
 *
 * The nodes move backwards through the zodiac: Rahu enters a sign at 30° and
 * leaves it at 0°, so its progress runs the other way. Forgetting this is the
 * classic gochar bug, and it inverts every "months remaining" figure.
 */
export function signProgress(planet: TransitPlanet, degree: number): SignProgress {
  const d = Math.min(30, Math.max(0, degree));
  const retrogradeNode = planet === 'Rahu' || planet === 'Ketu';
  const fraction = retrogradeNode ? (30 - d) / 30 : d / 30;
  return {
    pct: round1(fraction * 100),
    monthsRemaining: round1((1 - fraction) * MONTHS_PER_SIGN[planet]),
  };
}

/** Sign count from `from` to `to`, inclusive of the start: the sign itself is 1. */
export function signsFrom(from: string, to: string): number | undefined {
  const a = signIndex(from);
  const b = signIndex(to);
  if (a < 0 || b < 0) return undefined;
  return ((b - a + 12) % 12) + 1;
}

// --- Saturn -----------------------------------------------------------------

export type SadeSatiPhase = 'rising' | 'peak' | 'setting';

/**
 * Saturn's position counted from the Moon, and what classical gochar calls it.
 *
 *   12th, 1st, 2nd  -> Sade Sati (seven and a half years, three phases)
 *   4th             -> Kantaka Shani, "small panoti" (~2.5 years)
 *   8th             -> Ashtama Shani, "small panoti" (~2.5 years)
 *   3rd, 6th, 11th  -> classically favourable
 *   anything else   -> a plain transit
 */
export interface SaturnTransit {
  fromMoon: number;
  kind: 'sade_sati' | 'dhaiya' | 'plain';
  phase?: SadeSatiPhase;
  dhaiyaName?: 'Kantaka Shani' | 'Ashtama Shani';
  favourable: boolean;
  progress: SignProgress;
  /** Sade Sati only: progress through the whole ~7.5-year cycle. */
  cycle?: { pct: number; monthsRemaining: number };
}

const SATURN_FAVOURABLE = new Set([3, 6, 11]);
const SADE_SATI_PHASE: Record<number, SadeSatiPhase> = { 12: 'rising', 1: 'peak', 2: 'setting' };
const SADE_SATI_PHASE_INDEX: Record<SadeSatiPhase, number> = { rising: 0, peak: 1, setting: 2 };

export function saturnFromMoon(moonSign: string, pos: TransitPosition): SaturnTransit | undefined {
  const fromMoon = signsFrom(moonSign, pos.sign);
  if (!fromMoon) return undefined;
  const progress = signProgress('Saturn', pos.degree);
  const base = { fromMoon, favourable: SATURN_FAVOURABLE.has(fromMoon), progress };

  const phase = SADE_SATI_PHASE[fromMoon];
  if (phase) {
    // Three signs of thirty degrees each: the cycle is ninety degrees of
    // Saturn's motion, and the current phase tells us which thirty we are in.
    const elapsedDeg = SADE_SATI_PHASE_INDEX[phase] * 30 + Math.min(30, Math.max(0, pos.degree));
    const cyclePct = elapsedDeg / 90;
    return {
      ...base,
      kind: 'sade_sati',
      phase,
      cycle: {
        pct: round1(cyclePct * 100),
        monthsRemaining: round1((1 - cyclePct) * 3 * MONTHS_PER_SIGN.Saturn),
      },
    };
  }
  if (fromMoon === 4) return { ...base, kind: 'dhaiya', dhaiyaName: 'Kantaka Shani' };
  if (fromMoon === 8) return { ...base, kind: 'dhaiya', dhaiyaName: 'Ashtama Shani' };
  return { ...base, kind: 'plain' };
}

// --- Jupiter ----------------------------------------------------------------

export interface JupiterTransit {
  fromMoon: number;
  /** Classical gochar: 2nd, 5th, 7th, 9th and 11th from the Moon. */
  favourable: boolean;
  dignity: Dignity;
  progress: SignProgress;
}

const JUPITER_FAVOURABLE = new Set([2, 5, 7, 9, 11]);

export function jupiterFromMoon(
  moonSign: string,
  pos: TransitPosition,
): JupiterTransit | undefined {
  const fromMoon = signsFrom(moonSign, pos.sign);
  if (!fromMoon) return undefined;
  return {
    fromMoon,
    favourable: JUPITER_FAVOURABLE.has(fromMoon),
    dignity: dignityOf('Jupiter', pos.sign as Sign),
    progress: signProgress('Jupiter', pos.degree),
  };
}

// --- Rahu / Ketu ------------------------------------------------------------

export interface NodesTransit {
  rahuFromMoon: number;
  /** Always opposite Rahu; carried explicitly so callers need not re-derive it. */
  ketuFromMoon: number;
  /** Classical gochar treats Rahu like Saturn: 3rd, 6th and 11th are easy. */
  favourable: boolean;
  progress: SignProgress;
}

const RAHU_FAVOURABLE = new Set([3, 6, 11]);

export function nodesFromMoon(moonSign: string, rahu: TransitPosition): NodesTransit | undefined {
  const rahuFromMoon = signsFrom(moonSign, rahu.sign);
  if (!rahuFromMoon) return undefined;
  return {
    rahuFromMoon,
    ketuFromMoon: ((rahuFromMoon + 6 - 1) % 12) + 1,
    favourable: RAHU_FAVOURABLE.has(rahuFromMoon),
    progress: signProgress('Rahu', rahu.degree),
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
