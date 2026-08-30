/** Topical categories shared by intents, context items and derived facts. */
export type DomainCategory =
  'career' | 'relationship' | 'health' | 'finance' | 'self' | 'timing' | 'general';

export type FactConfidence = 'high' | 'medium' | 'low';

/**
 * A conclusion the engine reached *before* the LLM was involved.
 *
 * `basis` records which raw upstream fields produced the statement. That
 * provenance is what lets the groundedness check verify an answer against real
 * data instead of trusting the model's own citation.
 */
export interface DerivedFact {
  id: string;
  label: string;
  categories: DomainCategory[];
  statement: string;
  confidence: FactConfidence;
  basis: string[];
}

export type BirthTimeReliability = 'exact' | 'approximate' | 'unknown';

/**
 * How much of the chart can be trusted.
 *
 * The lagna advances one degree roughly every four minutes, so a birth time that
 * is rounded to the half hour can put the ascendant in the wrong sign entirely.
 * When that happens, every house-based statement is unsafe and the only reliable
 * anchor left is the Moon sign, which moves ~13 degrees a day and survives a
 * time error of hours. Astrologers make this fallback routinely; a naive
 * pipeline sends the houses regardless and states them with full confidence.
 */
export interface ChartReliability {
  birthTime: BirthTimeReliability;
  /** False when house/lagna statements must be suppressed. */
  housesUsable: boolean;
  /** Structural contradictions found in the upstream chart payload. */
  inconsistencies: string[];
  notes: string[];
}
