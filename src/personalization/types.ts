import { DomainCategory, FactConfidence, ChartReliability } from '../astrology/types';
import { UpstreamName } from '../upstream/types';

export type Intent =
  'career' | 'relationship' | 'health' | 'finance' | 'daily' | 'spiritual' | 'general';

/**
 * Temporal scope of the question.
 *
 * This is a first-class selection axis, not a detail. The sample questions in
 * the brief span "today", "this week", "this month" and "the next few months",
 * and the right context differs sharply between them: the panchang is the whole
 * answer for today and pure noise for a six-month horizon, while the dasha is
 * the reverse. Selecting on intent alone throws that signal away.
 */
export type Horizon = 'today' | 'week' | 'month' | 'quarter' | 'year' | 'lifetime' | 'unspecified';

export type Tone = 'motivational' | 'gentle' | 'analytical' | 'direct' | 'neutral';

/** How much Sanskrit/Jyotisha vocabulary the reader can absorb. */
export type JargonLevel = 'plain' | 'balanced' | 'technical';

export interface IntentResult {
  intent: Intent;
  /** 0-1. Drives whether the LLM fallback is worth paying for. */
  confidence: number;
  /** Additional intents detected in a compound question. */
  secondary: Intent[];
  method: 'lexicon' | 'llm' | 'default';
  /** Matched terms, for the debug endpoint. */
  signals: string[];
}

/** One atomic piece of context that may or may not be sent to the LLM. */
export interface ContextItem {
  /** Dotted id used by the rules config, e.g. `kundli.house.10`. */
  id: string;
  /** Human label. These become the response's `sourcesUsed`. */
  label: string;
  /**
   * Optional coarser name used in `sourcesUsed`, so four panchang limbs surface
   * to the user as one "Today's Panchang" rather than as Tithi/Yoga/Karana/
   * Nakshatra. The fine-grained label is still what the debug endpoint shows.
   */
  displayGroup?: string;
  source: UpstreamName | 'derived';
  categories: DomainCategory[];
  /** Rendered text as it would appear in the prompt. */
  text: string;
  tokens: number;
  confidence: FactConfidence;
  /** Upstream fields this item was built from. Used by the groundedness check. */
  basis: string[];
  /** Age in ms when the underlying source was served from cache. */
  ageMs?: number;
  stale?: boolean;
  /**
   * Ids of items this one makes redundant. A derived fact restates the raw
   * field it was computed from, so keeping both pays twice for one fact.
   */
  supersedes?: string[];
}

export interface ScoredItem extends ContextItem {
  score: number;
  tier: 'primary' | 'secondary' | 'neutral';
  reason: string;
}

export type ExclusionReason =
  | 'rule:excluded'
  | 'rule:horizon-drop'
  | 'rule:below-threshold'
  | 'budget'
  | 'reliability'
  | 'unavailable';

export interface ExcludedItem {
  id: string;
  label: string;
  reason: ExclusionReason;
  detail: string;
}

export interface ResponseStyle {
  /** ISO code as supplied by the profile. */
  languageCode: string;
  /** Normalised subscription tier; drives both length and context budget. */
  tier: string;
  /** Display name used in the prompt, e.g. "Hindi". */
  language: string;
  tone: Tone;
  maxWords: number;
  jargonLevel: JargonLevel;
}

/**
 * The complete decision record for one request.
 *
 * Everything the engine decided, why it decided it, and what it cost. The
 * pipeline consumes it, the debug endpoint renders it, and the logs summarise
 * it - so the explanation shown to a reviewer is the same object that drove
 * the behaviour, and cannot drift from it.
 */
export interface PersonalizationPlan {
  intent: Intent;
  intentConfidence: number;
  intentMethod: IntentResult['method'];
  secondaryIntents: Intent[];
  horizon: Horizon;
  style: ResponseStyle;
  selected: ScoredItem[];
  excluded: ExcludedItem[];
  tokenBudget: number;
  tokensUsed: number;
  /** Tokens the full candidate set would have cost, had all of it been sent. */
  tokensAvailable: number;
  /**
   * Tokens a naive implementation would spend by dumping the four raw upstream
   * JSON payloads into the prompt. This is the honest baseline: it is what the
   * obvious implementation actually does, whereas `tokensAvailable` measures
   * only the reduction within our own candidate set.
   */
  naiveBaselineTokens: number;
  reliability: ChartReliability;
  /** Safety constraints to inject into the prompt. */
  constraints: string[];
  notes: string[];
}
