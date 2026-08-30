import { Horizon, Intent, JargonLevel, Tone } from '../types';

/**
 * Response-shaping configuration.
 *
 * Personalization is not only *what* we say but *how*. Tone, length and jargon
 * level are treated as independent, individually configurable axes rather than
 * a single "style" string, because they come from different places: tone from an
 * explicit user preference, length from subscription tier and question scope,
 * jargon from how much Jyotisha vocabulary the reader can absorb.
 */

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  hi: 'Hindi',
  hinglish: 'Hinglish',
  mr: 'Marathi',
  ta: 'Tamil',
  te: 'Telugu',
  pa: 'Punjabi',
  bn: 'Bengali',
  gu: 'Gujarati',
  kn: 'Kannada',
  ml: 'Malayalam',
};

/**
 * Per-language prompt directives.
 *
 * Hinglish is the interesting case and the one a generic implementation gets
 * wrong: it is Hindi vocabulary in Latin script, not English with Hindi words
 * sprinkled in, and asking a model for "Hindi" when the user picked Hinglish
 * produces Devanagari the user may not read comfortably.
 */
export const LANGUAGE_DIRECTIVES: Record<string, string> = {
  en: 'Write in clear, natural English.',
  hi: 'Write in natural conversational Hindi using Devanagari script. Do not transliterate into Latin script.',
  // A bare description of Hinglish is not enough - models reliably fall back to
  // plain English when only told the register in the abstract. A one-line
  // exemplar is what actually makes the instruction stick.
  hinglish:
    'Write in HINGLISH, not English. Hinglish is conversational Hindi written in Latin script, mixed naturally with English words the way urban Indians actually speak. Use Latin script only - no Devanagari. Match this register exactly: "Abhi ka time thoda transition ka hai - naya job dhoondhna theek hai, but decision jaldbazi mein mat lena." Do NOT answer in plain English.',
  mr: 'Write in natural conversational Marathi using Devanagari script.',
  ta: 'Write in natural conversational Tamil using Tamil script.',
  te: 'Write in natural conversational Telugu using Telugu script.',
  pa: 'Write in natural conversational Punjabi using Gurmukhi script.',
};

export const DEFAULT_LANGUAGE = 'en';

export const TONE_DIRECTIVES: Record<Tone, string> = {
  motivational:
    'Encouraging and forward-looking. Frame challenges as things the user can work with. Never hollow cheerleading - the encouragement has to follow from the chart.',
  gentle:
    'Warm, calm and reassuring. Soften difficult indications without hiding them. Assume the user may already be anxious about this.',
  analytical:
    'Precise and structured. Lead with the astrological reasoning, then the implication. Prefer specifics over comfort.',
  direct:
    'Concise and plain-spoken. Give the answer first, then the reasoning. No preamble, no hedging beyond what accuracy requires.',
  neutral: 'Balanced and informative. Neither dramatic nor dismissive.',
};

export const TONE_ALIASES: Record<string, Tone> = {
  motivational: 'motivational',
  motivating: 'motivational',
  encouraging: 'motivational',
  positive: 'motivational',
  gentle: 'gentle',
  soft: 'gentle',
  compassionate: 'gentle',
  calm: 'gentle',
  analytical: 'analytical',
  technical: 'analytical',
  detailed: 'analytical',
  direct: 'direct',
  blunt: 'direct',
  concise: 'direct',
  neutral: 'neutral',
};

export const JARGON_DIRECTIVES: Record<JargonLevel, string> = {
  plain:
    'Avoid Sanskrit astrological terms. If a concept like a dasha period is needed, describe it in everyday language without naming it.',
  balanced:
    'Use common terms (dasha, lagna, rashi, nakshatra) but explain each one briefly the first time it appears.',
  technical:
    'Use standard Jyotisha terminology directly (mahadasha, antardasha, bhava, karaka). The reader is familiar with it.',
};

/** Word budget by subscription tier. */
export const TIER_BASE_WORDS: Record<string, number> = {
  free: 120,
  premium: 250,
};

export const DEFAULT_TIER = 'free';

/** Shorter horizons need less prose; a life-scale question needs more. */
export const HORIZON_LENGTH_FACTOR: Record<Horizon, number> = {
  today: 0.8,
  week: 0.85,
  month: 1,
  quarter: 1,
  year: 1.1,
  lifetime: 1.1,
  unspecified: 1,
};

/** A "summarise today" answer should be short even for a premium user. */
export const INTENT_LENGTH_FACTOR: Partial<Record<Intent, number>> = {
  daily: 0.7,
};

export const MIN_WORDS = 80;
export const MAX_WORDS = 350;

/** Jargon default by tier, until an explicit user preference exists upstream. */
export const TIER_JARGON: Record<string, JargonLevel> = {
  free: 'plain',
  premium: 'balanced',
};
