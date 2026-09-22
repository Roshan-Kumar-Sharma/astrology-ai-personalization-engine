import { DomainCategory } from '../../astrology/types';
import { Planet } from '../../astrology/zodiac';
import { Horizon, Intent } from '../types';

/**
 * The Personalization Engine's rule table.
 *
 * Everything about *what context a question deserves* lives here as data.
 * Adding an intent, an upstream service or a new selection heuristic is a change
 * to this file; the selector itself never grows an if/else branch. That is the
 * whole design goal - the brief explicitly warns against large conditional
 * blocks, and rules encoded as data can also be unit-tested, diffed in review,
 * and eventually moved to a database or a remote config service without
 * touching the pipeline.
 *
 * Item ids are dotted paths with `*` wildcards, matched against ContextItem.id:
 *   kundli.house.10        exact
 *   derived.dasha.*        prefix
 *   horoscope.*            prefix
 */

export interface HorizonOverride {
  /**
   * Add `HORIZON_ADJUSTMENTS.promote` - these matter more at this horizon. A
   * background item rises above the relevance floor; a secondary one rises to
   * primary weight, and no further (the selector caps it there).
   */
  promote?: string[];
  /**
   * Add `HORIZON_ADJUSTMENTS.demote` - still allowed, but ranked lower. A
   * primary item lands at secondary weight; a secondary one falls below the
   * relevance floor and is excluded.
   */
  demote?: string[];
  /** Remove entirely - actively misleading at this horizon. */
  drop?: string[];
  /** Explanation surfaced in the debug endpoint. */
  why?: string;
}

export interface IntentRule {
  intent: Intent;
  description: string;
  /** Domain categories used to decide which derived facts to compute. */
  categories: DomainCategory[];
  primary: string[];
  secondary: string[];
  /** Never sent for this intent, regardless of budget. */
  exclude: string[];
  horizonOverrides?: Partial<Record<Horizon, HorizonOverride>>;
}

/**
 * The transit facts a long horizon promotes.
 *
 * Deliberately not `derived.transit.*`. That wildcard also matches the
 * house-relative facts (`derived.transit.jupiter.house.4`), and promotion adds
 * enough weight to lift a neutral item over the relevance floor - so a year-
 * horizon career question started sending "Jupiter over the 4th house", which
 * has nothing to do with career, and squeezed the career horoscope out of a
 * free-tier budget. Promotion may re-rank what a rule already admits; it must
 * not admit what the rule left out. The house-relative facts earn their place
 * only where a rule names the house.
 */
const TRANSIT_PROMOTE = [
  'derived.transit.sade_sati',
  'derived.transit.dhaiya',
  'derived.transit.saturn',
  'derived.transit.jupiter',
];

export const INTENT_RULES: Record<Intent, IntentRule> = {
  career: {
    intent: 'career',
    description: 'Work, job change, promotion, business direction, professional status.',
    categories: ['career', 'finance', 'timing'],
    primary: [
      'derived.house.10',
      'kundli.house.10',
      'horoscope.career',
      'derived.dasha.position',
      'derived.dasha.transition',
      'derived.dasha.house_rulership',
      // Saturn over the Moon (Sade Sati / dhaiya) or over the 10th is the
      // classic "should I change my job" transit.
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
      'derived.transit.saturn.house.10',
    ],
    secondary: [
      'derived.house.6', // service / daily work / competition
      'kundli.house.6',
      'derived.house.11', // gains from work
      'kundli.house.11',
      'derived.dasha.themes',
      'kundli.lagna',
      'horoscope.finance',
      'derived.transit.saturn',
      'derived.transit.jupiter',
      'derived.transit.jupiter.house.10',
      'derived.transit.saturn.house.6',
      'derived.transit.jupiter.house.11',
      'derived.transit.nodes',
    ],
    exclude: ['horoscope.relationship', 'horoscope.health', 'kundli.house.7', 'derived.house.7'],
    horizonOverrides: {
      today: {
        promote: ['panchang.*', 'derived.panchang.*'],
        demote: ['derived.dasha.transition', 'derived.transit.*'],
        why: 'A single day is governed by the panchang; a multi-year dasha arc or a transit that lasts years cannot resolve to one day.',
      },
      week: {
        promote: ['derived.panchang.resonance'],
        demote: ['panchang.tithi', 'panchang.karana'],
        why: 'Week-level questions want the daily rhythm only where it resonates with the running dasha.',
      },
      quarter: {
        drop: ['panchang.*', 'derived.panchang.*'],
        promote: TRANSIT_PROMOTE,
        why: 'Panchang describes a single day and is actively misleading over a multi-month horizon. What it loses here the gochar gains: a Saturn or Jupiter transit is exactly a multi-month signal.',
      },
      year: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*'],
        promote: TRANSIT_PROMOTE,
        why: 'Panchang describes one day and carries no signal across a year, so it is dropped. The daily horoscope is chart-derived and often echoes the running dasha, so it is down-ranked rather than discarded. The transits are promoted: a year is the scale they actually describe.',
      },
      lifetime: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*', 'derived.transit.*'],
        why: 'Only the natal chart and the dasha arc are meaningful at this scale. A transit lasting two or three years is a current condition, not a life pattern, so it is down-ranked here too.',
      },
    },
  },

  relationship: {
    intent: 'relationship',
    description: 'Marriage, partner, romance, compatibility, family bonds.',
    categories: ['relationship', 'self', 'timing'],
    primary: [
      'derived.house.7',
      'kundli.house.7',
      'horoscope.relationship',
      'derived.dasha.position',
      'derived.dasha.house_rulership',
      // Jupiter's transit is the classical marriage-timing signal; Sade Sati
      // colours every relationship question it overlaps.
      'derived.transit.jupiter',
      'derived.transit.jupiter.house.7',
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
    ],
    secondary: [
      'derived.house.5', // romance
      'kundli.house.5',
      'derived.moon.placement',
      'kundli.moonSign',
      'derived.dasha.themes',
      'derived.house.2', // family
      'derived.transit.saturn',
      'derived.transit.saturn.house.7',
    ],
    exclude: ['horoscope.career', 'horoscope.finance', 'kundli.house.10', 'derived.house.10'],
    horizonOverrides: {
      today: {
        promote: ['panchang.*', 'derived.panchang.*'],
        demote: ['derived.dasha.transition', 'derived.transit.*'],
        why: 'Same-day relationship questions are about mood and timing, not the life arc.',
      },
      quarter: {
        drop: ['panchang.*', 'derived.panchang.*'],
        promote: TRANSIT_PROMOTE,
        why: 'Daily almanac data does not extend across months; the slow transits are what does.',
      },
      year: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*'],
        promote: TRANSIT_PROMOTE,
      },
      lifetime: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*', 'derived.transit.*'],
      },
    },
  },

  health: {
    intent: 'health',
    description: 'Wellbeing, energy, routine, recovery, mental and physical health.',
    categories: ['health', 'self', 'timing'],
    primary: [
      'derived.house.6',
      'kundli.house.6',
      'horoscope.health',
      // The 1st house governs vitality and the body itself. Any health mapping
      // that stops at the 6th house is incomplete - the 6th is illness, the 1st
      // is the constitution that resists it.
      'derived.house.1',
      'kundli.house.1',
      // Saturn over the Moon, or over the houses of the body (1st), illness
      // (6th) and crisis (8th), is the health transit that matters.
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
      'derived.transit.saturn.house.6',
      'derived.transit.saturn.house.1',
      'derived.transit.saturn.house.8',
    ],
    secondary: [
      'derived.moon.placement', // Moon governs the mind; central to mental health
      'kundli.moonSign',
      'derived.dasha.position',
      'derived.dasha.themes',
      'panchang.nakshatra',
      'derived.transit.saturn',
      'derived.transit.jupiter',
    ],
    exclude: ['horoscope.finance', 'horoscope.career', 'kundli.house.10', 'derived.house.10'],
    horizonOverrides: {
      today: { promote: ['panchang.*', 'derived.panchang.*'], demote: ['derived.transit.*'] },
      quarter: { drop: ['panchang.*', 'derived.panchang.*'], promote: TRANSIT_PROMOTE },
      year: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*'],
        promote: TRANSIT_PROMOTE,
      },
      lifetime: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*', 'derived.transit.*'],
      },
    },
  },

  finance: {
    intent: 'finance',
    description: 'Money, savings, income, investments, debts, expenditure.',
    categories: ['finance', 'career', 'timing'],
    primary: [
      'derived.house.2',
      'kundli.house.2',
      'derived.house.11',
      'kundli.house.11',
      'horoscope.finance',
      'derived.dasha.position',
      // Jupiter is the natural significator of wealth; its transit over the
      // Moon or over the money houses is the finance transit.
      'derived.transit.jupiter',
      'derived.transit.jupiter.house.2',
      'derived.transit.jupiter.house.11',
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
    ],
    secondary: [
      'derived.dasha.house_rulership',
      'derived.dasha.themes',
      'horoscope.career',
      'derived.house.10',
      'kundli.lagna',
      'derived.transit.saturn',
      'derived.transit.saturn.house.2',
      'derived.transit.saturn.house.11',
      'derived.transit.nodes',
    ],
    exclude: ['horoscope.relationship', 'horoscope.health', 'kundli.house.7', 'derived.house.7'],
    horizonOverrides: {
      today: { promote: ['panchang.*', 'derived.panchang.*'], demote: ['derived.transit.*'] },
      quarter: { drop: ['panchang.*', 'derived.panchang.*'], promote: TRANSIT_PROMOTE },
      year: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*'],
        promote: TRANSIT_PROMOTE,
      },
      lifetime: {
        drop: ['panchang.*', 'derived.panchang.*'],
        demote: ['horoscope.*', 'derived.transit.*'],
      },
    },
  },

  /**
   * "What should I prioritise this week?" / "Summarise today's guidance."
   * Distinct from `general`: the user is asking about a *window of time*, not a
   * life area, so the almanac leads and the natal chart provides colour.
   */
  daily: {
    intent: 'daily',
    description: 'Guidance for today or the coming days; what to prioritise now.',
    categories: ['timing', 'general', 'self'],
    primary: [
      'panchang.tithi',
      'panchang.nakshatra',
      'panchang.yoga',
      'derived.panchang.resonance',
      'derived.panchang.lord',
    ],
    secondary: [
      'horoscope.career',
      'horoscope.health',
      'horoscope.relationship',
      'horoscope.finance',
      'derived.dasha.position',
      'derived.dasha.themes',
      'panchang.karana',
      // Backdrop only: a day is not characterised by a multi-year transit, but
      // a user in Sade Sati should not be told about their day as if it were not.
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
    ],
    exclude: [],
    horizonOverrides: {
      month: {
        demote: ['panchang.karana', 'panchang.tithi'],
        promote: ['derived.dasha.position'],
        why: 'Tithi and karana turn over within a day and cannot characterise a month.',
      },
      quarter: {
        drop: ['panchang.karana', 'panchang.tithi', 'panchang.yoga', 'derived.panchang.lord'],
      },
    },
  },

  spiritual: {
    intent: 'spiritual',
    description: 'Remedies, mantras, fasting, temple visits, dharma and practice.',
    categories: ['self', 'timing', 'general'],
    primary: [
      'derived.dasha.position',
      'derived.dasha.themes',
      'panchang.tithi',
      'panchang.nakshatra',
      'derived.panchang.resonance',
      // Remedies for Shani are the single most common spiritual request, and
      // they only make sense if the engine knows a Saturn transit is running.
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
    ],
    secondary: [
      'derived.moon.placement',
      'kundli.moonSign',
      'kundli.lagna',
      'panchang.yoga',
      'derived.transit.saturn',
      'derived.transit.jupiter',
      'derived.transit.nodes',
    ],
    exclude: ['horoscope.finance', 'horoscope.career'],
  },

  /**
   * The catch-all. Sends a thin slice of every area rather than everything -
   * "all available context" in the brief's example table is the one place where
   * naive selection is tempting, and it is exactly where token spend explodes.
   */
  general: {
    intent: 'general',
    description: 'Open-ended or unclassified questions.',
    categories: ['general', 'self', 'career', 'relationship', 'health', 'finance', 'timing'],
    primary: [
      'derived.dasha.position',
      'derived.dasha.transition',
      'kundli.lagna',
      'kundli.moonSign',
      // "Is my Sade Sati over?" has no life-area and lands here. It must be
      // answerable.
      'derived.transit.sade_sati',
      'derived.transit.dhaiya',
    ],
    secondary: [
      'derived.dasha.themes',
      'horoscope.career',
      'horoscope.relationship',
      'horoscope.health',
      'horoscope.finance',
      'derived.house.1',
      'derived.house.10',
      'panchang.nakshatra',
      'derived.panchang.resonance',
      'derived.transit.saturn',
      'derived.transit.jupiter',
      'derived.transit.nodes',
    ],
    exclude: [],
    horizonOverrides: {
      today: {
        promote: ['panchang.*', 'derived.panchang.*', 'horoscope.*'],
        demote: ['derived.transit.*'],
      },
      quarter: { drop: ['panchang.*', 'derived.panchang.*'], promote: TRANSIT_PROMOTE },
      year: { drop: ['panchang.*', 'derived.panchang.*'], promote: TRANSIT_PROMOTE },
      lifetime: { drop: ['panchang.*', 'derived.panchang.*'], demote: ['derived.transit.*'] },
    },
  },
};

/** Scoring weights. Kept here so tuning never requires touching the selector. */
export const TIER_WEIGHTS = {
  primary: 100,
  secondary: 55,
  neutral: 15,
} as const;

export const HORIZON_ADJUSTMENTS = {
  promote: 60,
  demote: -45,
} as const;

/**
 * What a question that names a planet pulls forward.
 *
 * Same weight as a horizon promotion, applied on top of it. Naming Saturn is a
 * stronger statement of relevance than any rule can infer from a life-area, so
 * the Saturn facts - including where Saturn sits in *this* chart - are lifted
 * even for an intent that would otherwise leave them as background. Bare
 * "gochar"/"transit" promotes every slow mover.
 */
export const FOCUS_PROMOTE: Partial<Record<Planet, string[]>> = {
  Saturn: [
    'derived.transit.sade_sati',
    'derived.transit.dhaiya',
    'derived.transit.saturn',
    'derived.transit.saturn.house.*',
  ],
  Jupiter: ['derived.transit.jupiter', 'derived.transit.jupiter.house.*'],
  Rahu: ['derived.transit.nodes'],
  Ketu: ['derived.transit.nodes'],
};

export const GOCHAR_PROMOTE = [
  'derived.transit.sade_sati',
  'derived.transit.dhaiya',
  'derived.transit.saturn',
  'derived.transit.jupiter',
  'derived.transit.nodes',
];

export const FOCUS_ADJUSTMENT = 60;

/** Multipliers applied for how much we trust an item. */
export const CONFIDENCE_MULTIPLIER: Record<'high' | 'medium' | 'low', number> = {
  high: 1,
  medium: 0.85,
  low: 0.6,
};

/** Penalty applied to items whose upstream was served stale. */
export const STALE_PENALTY = 0.75;

/**
 * Minimum score an item must reach to be sent at all.
 *
 * Without a floor, a generous budget silently turns into "send everything that
 * fits" - a premium user would receive every tangential item simply because
 * there was room, which is the exact behaviour this engine exists to avoid.
 * Relevance decides what is admissible; the budget only decides how much of the
 * admissible set fits. Set just above the neutral tier weight so background
 * items are excluded on relevance rather than on budget.
 */
export const MIN_SCORE_THRESHOLD = 30;

/** Matches a ContextItem id against a rule pattern supporting a trailing `*`. */
export function matchesPattern(id: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
  return id === pattern;
}

export function matchesAny(id: string, patterns: string[]): boolean {
  return patterns.some((p) => matchesPattern(id, p));
}
