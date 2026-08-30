import { Injectable } from '@nestjs/common';
import { Intent, IntentResult } from '../types';
import { LEXICON, PHRASES } from './lexicon';

/**
 * Score at which the lexical evidence is considered fully convincing. Roughly
 * one strong phrase match, or two independent keyword matches.
 */
const STRONG_SIGNAL_SCORE = 1.5;

const ALL_INTENTS: Intent[] = [
  'career',
  'relationship',
  'health',
  'finance',
  'daily',
  'spiritual',
  'general',
];

/**
 * Deterministic, sub-millisecond intent classification.
 *
 * An LLM call per request to decide "is this a career question?" is the easiest
 * way to make this service slow and expensive, and it is unnecessary for the
 * overwhelming majority of traffic: real questions in this product contain the
 * word "job" or "shaadi". The lexicon resolves those for free and returns a
 * calibrated confidence so the pipeline can pay for an LLM only on the genuinely
 * ambiguous tail.
 *
 * Being deterministic also makes intent testable, cacheable and explainable -
 * three properties an LLM classifier cannot offer.
 */
@Injectable()
export class IntentClassifier {
  classify(question: string): IntentResult {
    const q = question.normalize('NFKC').toLowerCase();
    const scores: Record<Intent, number> = Object.fromEntries(
      ALL_INTENTS.map((i) => [i, 0]),
    ) as Record<Intent, number>;
    const signals: string[] = [];

    // Phrases first: they subsume their component words and carry more signal.
    for (const entry of PHRASES) {
      if (q.includes(entry.term)) {
        applyWeights(scores, entry.weights);
        signals.push(entry.term);
      }
    }

    // Collect lexicon hits before scoring so overlapping entries can be
    // resolved. "investments" matches both `invest` and `investment`; scoring
    // both double-counts one piece of evidence and skews the intent margin.
    const lexHits = LEXICON.filter((entry) => containsTerm(q, entry.term));
    const longestWins = lexHits.filter(
      (entry) => !lexHits.some((other) => other !== entry && other.term.includes(entry.term)),
    );

    for (const entry of longestWins) {
      applyWeights(scores, entry.weights);
      signals.push(entry.term);
    }

    const ranked = ALL_INTENTS.filter((i) => i !== 'general')
      .map((intent) => ({ intent, score: scores[intent] }))
      .sort((a, b) => b.score - a.score);

    const top = ranked[0];
    const runnerUp = ranked[1];

    if (!top || top.score === 0) {
      return {
        intent: 'general',
        confidence: 0.3,
        secondary: [],
        method: 'default',
        signals: [],
      };
    }

    // A "daily" signal alongside a topical one means the topic wins and the
    // temporal word is handled by the horizon extractor instead. "How does this
    // week look for my relationship?" is a relationship question about a week,
    // not a daily question.
    let winner = top;
    if (top.intent === 'daily' && runnerUp && runnerUp.score >= top.score * 0.6) {
      winner = runnerUp;
    }

    const second = ranked.find((r) => r.intent !== winner.intent)?.score ?? 0;

    // Confidence has two independent components, and using only the first is a
    // trap: a question matching one weak term with no competitor scores a
    // perfect margin and would otherwise report near-certainty.
    //   margin   - how far ahead the winner is of the runner-up
    //   strength - how much evidence there was in absolute terms
    const margin = (winner.score - second) / winner.score;
    const strength = Math.min(1, 0.6 + (0.4 * winner.score) / STRONG_SIGNAL_SCORE);
    const confidence = clamp((0.45 + 0.55 * margin) * strength, 0.35, 0.98);

    const secondary = ranked
      .filter((r) => r.intent !== winner.intent && r.score > 0 && r.score >= winner.score * 0.5)
      .map((r) => r.intent);

    return {
      intent: winner.intent,
      confidence: round2(confidence),
      secondary,
      method: 'lexicon',
      signals: [...new Set(signals)],
    };
  }
}

/**
 * Word matching with bounded inflection.
 *
 * A bare prefix match ("\binvest") catches the inflections we want
 * - investment, investing, invests - but also matches "investigation", which
 * has nothing to do with finance. Requiring a full word boundary instead would
 * break every inflection. So the term may be followed only by a short list of
 * real English suffixes before the boundary.
 *
 * Devanagari and other Indic scripts have no ASCII word boundaries, so they
 * fall back to substring matching.
 */
const INFLECTIONS = '(?:s|es|ed|d|ing|ment|ments|ance|al)?';

function containsTerm(haystack: string, term: string): boolean {
  if (!/^[\x20-\x7e]+$/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}${INFLECTIONS}\\b`, 'i').test(haystack);
}

function applyWeights(scores: Record<Intent, number>, weights: Partial<Record<Intent, number>>) {
  for (const [intent, w] of Object.entries(weights) as [Intent, number][]) {
    scores[intent] += w;
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
