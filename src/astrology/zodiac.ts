/**
 * Vedic (sidereal) zodiac reference data.
 *
 * Pure data + pure functions, no I/O. Everything the inference engine concludes
 * is derived from this table, which makes each conclusion auditable: a reviewer
 * can check a claim against the classical rule rather than trusting the code.
 *
 * Uses traditional seven-planet rulership plus the two lunar nodes. The outer
 * planets (Uranus/Neptune/Pluto) are deliberately absent - they are not part of
 * classical Jyotisha and do not rule signs.
 */

export const SIGNS = [
  'Aries',
  'Taurus',
  'Gemini',
  'Cancer',
  'Leo',
  'Virgo',
  'Libra',
  'Scorpio',
  'Sagittarius',
  'Capricorn',
  'Aquarius',
  'Pisces',
] as const;

export type Sign = (typeof SIGNS)[number];

export type Planet =
  'Sun' | 'Moon' | 'Mars' | 'Mercury' | 'Jupiter' | 'Venus' | 'Saturn' | 'Rahu' | 'Ketu';

/** Sign rulership (adhipati). */
export const SIGN_LORD: Record<Sign, Planet> = {
  Aries: 'Mars',
  Taurus: 'Venus',
  Gemini: 'Mercury',
  Cancer: 'Moon',
  Leo: 'Sun',
  Virgo: 'Mercury',
  Libra: 'Venus',
  Scorpio: 'Mars',
  Sagittarius: 'Jupiter',
  Capricorn: 'Saturn',
  Aquarius: 'Saturn',
  Pisces: 'Jupiter',
};

/** Exaltation (uccha) signs. Rahu/Ketu are disputed across schools and omitted. */
export const EXALTATION: Partial<Record<Planet, Sign>> = {
  Sun: 'Aries',
  Moon: 'Taurus',
  Mars: 'Capricorn',
  Mercury: 'Virgo',
  Jupiter: 'Cancer',
  Venus: 'Pisces',
  Saturn: 'Libra',
};

/** Debilitation (neecha) is always the sign opposite exaltation. */
export const DEBILITATION: Partial<Record<Planet, Sign>> = {
  Sun: 'Libra',
  Moon: 'Scorpio',
  Mars: 'Cancer',
  Mercury: 'Pisces',
  Jupiter: 'Capricorn',
  Venus: 'Virgo',
  Saturn: 'Aries',
};

/** Own sign (swakshetra) - a planet in a sign it rules. */
export function ownsSign(planet: Planet, sign: Sign): boolean {
  return SIGN_LORD[sign] === planet;
}

export type Dignity = 'exalted' | 'debilitated' | 'own sign' | 'neutral';

export function dignityOf(planet: Planet, sign: Sign): Dignity {
  if (EXALTATION[planet] === sign) return 'exalted';
  if (DEBILITATION[planet] === sign) return 'debilitated';
  if (ownsSign(planet, sign)) return 'own sign';
  return 'neutral';
}

export function signIndex(sign: string): number {
  return SIGNS.indexOf(normalizeSign(sign) as Sign);
}

export function normalizeSign(sign: string): string {
  const t = sign.trim().toLowerCase();
  const found = SIGNS.find((s) => s.toLowerCase() === t);
  if (found) return found;
  // Accept common Sanskrit/Hindi rashi names.
  return RASHI_ALIASES[t] ?? sign;
}

const RASHI_ALIASES: Record<string, Sign> = {
  mesha: 'Aries',
  mesh: 'Aries',
  vrishabha: 'Taurus',
  vrish: 'Taurus',
  vrishab: 'Taurus',
  mithuna: 'Gemini',
  mithun: 'Gemini',
  karka: 'Cancer',
  kark: 'Cancer',
  kataka: 'Cancer',
  simha: 'Leo',
  sinh: 'Leo',
  kanya: 'Virgo',
  tula: 'Libra',
  thula: 'Libra',
  vrischika: 'Scorpio',
  vrishchik: 'Scorpio',
  dhanu: 'Sagittarius',
  dhanus: 'Sagittarius',
  makara: 'Capricorn',
  makar: 'Capricorn',
  kumbha: 'Aquarius',
  kumbh: 'Aquarius',
  meena: 'Pisces',
  meen: 'Pisces',
};

/**
 * Which house does `sign` occupy for a chart with the given lagna?
 * Whole-sign houses, the standard North-Indian convention.
 */
export function houseOfSign(lagna: string, sign: string): number | undefined {
  const l = signIndex(lagna);
  const s = signIndex(sign);
  if (l < 0 || s < 0) return undefined;
  return ((s - l + 12) % 12) + 1;
}

/** The sign occupying a given house for a chart with the given lagna. */
export function signOfHouse(lagna: string, house: number): Sign | undefined {
  const l = signIndex(lagna);
  if (l < 0 || house < 1 || house > 12) return undefined;
  return SIGNS[(l + house - 1) % 12];
}

/** The lord of a house, derived from the lagna. */
export function lordOfHouse(lagna: string, house: number): Planet | undefined {
  const sign = signOfHouse(lagna, house);
  return sign ? SIGN_LORD[sign] : undefined;
}

/** Bhava significations, condensed to what an answer would actually use. */
export const HOUSE_MEANING: Record<number, string> = {
  1: 'self, vitality, overall life direction',
  2: 'accumulated wealth, family, speech',
  3: 'courage, initiative, siblings, short travel',
  4: 'home, mother, property, inner peace',
  5: 'creativity, children, romance, intellect',
  6: 'daily work and service, health and illness, debts, competition',
  7: 'marriage, partnership, one-to-one relationships',
  8: 'transformation, sudden change, longevity, research',
  9: 'fortune, mentors, higher learning, dharma',
  10: 'career, profession, status, public reputation',
  11: 'income, gains, networks, fulfilment of desires',
  12: 'expenditure, foreign lands, rest, letting go',
};

/** Natural significator (karaka) themes, used to colour dasha interpretation. */
export const PLANET_THEME: Record<Planet, string> = {
  Sun: 'authority, recognition, self-confidence',
  Moon: 'mind, emotional rhythm, adaptability',
  Mars: 'drive, initiative, decisive action, friction if rushed',
  Mercury: 'communication, analysis, commerce, negotiation',
  Jupiter: 'growth, wisdom, mentors, expansion',
  Venus: 'relationships, comfort, artistry, harmony',
  Saturn: 'discipline, structure, patience, slow durable gains',
  Rahu: 'ambition, unconventional moves, sudden acceleration',
  Ketu: 'detachment, refinement, letting go of what is finished',
};
