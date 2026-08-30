import { Injectable } from '@nestjs/common';
import { SOURCE_CRITICALITY } from '../upstream/cache-policy';
import { bundleResults, ContextBundle } from '../upstream/types';
import { PersonalizationPlan } from '../personalization/types';
import { GroundednessReport } from './groundedness.service';

export type ConfidenceLabel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ConfidenceBreakdown {
  label: ConfidenceLabel;
  score: number;
  factors: { name: string; weight: number; value: number; note: string }[];
  caps: string[];
}

const WEIGHTS = {
  dataCompleteness: 0.3,
  contextCoverage: 0.2,
  intentCertainty: 0.15,
  birthTimeReliability: 0.2,
  groundedness: 0.15,
} as const;

const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.55;

/**
 * Computes the response confidence from measurable properties of the request.
 *
 * The obvious implementation is to ask the LLM how confident it is. That
 * produces a number correlated with the model's fluency rather than with
 * anything real - it will happily report HIGH on an answer built from a failed
 * kundli call and an unknown birth time, because the prose came out well.
 *
 * Every factor here is something the service actually knows:
 *
 *   dataCompleteness  - which upstreams answered, weighted by how much each one
 *                       matters
 *   contextCoverage   - whether we found context that primarily addresses this
 *                       question, or only tangential material
 *   intentCertainty   - how sure the classifier was about what was being asked
 *   birthTimeReliability - whether the chart can support house-level claims at all
 *   groundedness      - whether the generated answer stayed inside the context
 *
 * Hard caps sit on top, because some failures are not trade-offs: without a
 * kundli there is no personalised astrology, however well everything else went.
 */
@Injectable()
export class ConfidenceService {
  compute(input: {
    bundle: ContextBundle;
    plan: PersonalizationPlan;
    groundedness?: GroundednessReport;
  }): ConfidenceBreakdown {
    const { bundle, plan, groundedness } = input;
    const factors: ConfidenceBreakdown['factors'] = [];
    const caps: string[] = [];

    // --- data completeness ---------------------------------------------------
    let completeness = 0;
    const degraded: string[] = [];
    for (const r of bundleResults(bundle)) {
      const criticality = SOURCE_CRITICALITY[r.source];
      const value =
        r.outcome === 'ok' || r.outcome === 'cached' ? 1 : r.outcome === 'stale' ? 0.6 : 0;
      completeness += criticality * value;
      if (value < 1) degraded.push(`${r.source}:${r.outcome}`);
    }
    factors.push({
      name: 'dataCompleteness',
      weight: WEIGHTS.dataCompleteness,
      value: round2(completeness),
      note: degraded.length ? `degraded sources - ${degraded.join(', ')}` : 'all sources healthy',
    });

    // --- context coverage ----------------------------------------------------
    const primaryCount = plan.selected.filter((i) => i.tier === 'primary').length;
    const coverage = primaryCount >= 2 ? 1 : primaryCount === 1 ? 0.7 : 0.3;
    factors.push({
      name: 'contextCoverage',
      weight: WEIGHTS.contextCoverage,
      value: coverage,
      note: `${primaryCount} primary-tier context item(s) selected for a ${plan.intent} question`,
    });

    // --- intent certainty ----------------------------------------------------
    factors.push({
      name: 'intentCertainty',
      weight: WEIGHTS.intentCertainty,
      value: plan.intentConfidence,
      note: `intent "${plan.intent}" via ${plan.intentMethod}`,
    });

    // --- birth time ----------------------------------------------------------
    const birthValue =
      plan.reliability.birthTime === 'exact'
        ? 1
        : plan.reliability.birthTime === 'approximate'
          ? 0.7
          : 0.4;
    factors.push({
      name: 'birthTimeReliability',
      weight: WEIGHTS.birthTimeReliability,
      value: birthValue,
      note:
        plan.reliability.birthTime === 'exact'
          ? 'birth time precise enough for house-level analysis'
          : plan.reliability.birthTime === 'approximate'
            ? 'birth time approximate; house cusps may shift'
            : 'birth time unknown; house analysis suppressed',
    });

    // --- groundedness --------------------------------------------------------
    const groundValue = groundedness?.score ?? 1;
    factors.push({
      name: 'groundedness',
      weight: WEIGHTS.groundedness,
      value: groundValue,
      note: groundedness
        ? groundedness.contractIgnored
          ? 'model ignored the output contract, so its citations could not be verified'
          : groundedness.ungroundedEntities.length
            ? `answer named context we never sent: ${groundedness.ungroundedEntities.join(', ')}`
            : 'answer stayed within the supplied context'
        : 'not evaluated (no generation performed)',
    });

    let score = factors.reduce((sum, f) => sum + f.weight * f.value, 0);

    // --- hard caps -----------------------------------------------------------
    if (bundle.kundli.outcome === 'failed') {
      score = Math.min(score, 0.5);
      caps.push('Kundli unavailable: no personalised chart analysis was possible.');
    }
    if (bundle.kundli.outcome === 'failed' && bundle.horoscope.outcome === 'failed') {
      score = Math.min(score, 0.35);
      caps.push('Both kundli and horoscope unavailable: the answer is effectively generic.');
    }
    if (!plan.reliability.housesUsable) {
      // Losing house analysis is categorical, not incremental: the ascendant,
      // every bhava and every house lord become unusable at once. A weighted
      // factor alone leaves the score in HIGH territory, which would tell the
      // user the answer is solid when half the chart was unreadable.
      score = Math.min(score, 0.7);
      caps.push(
        'Birth time cannot support house division; reasoning limited to the Moon sign and the running dasha.',
      );
    }
    if (plan.reliability.inconsistencies.length) {
      score = Math.min(score, 0.6);
      caps.push(
        `Chart failed consistency validation: ${plan.reliability.inconsistencies.join(' ')}`,
      );
    }
    if (!plan.selected.length) {
      score = Math.min(score, 0.3);
      caps.push('No context could be selected.');
    }

    score = Math.round(score * 100) / 100;

    return {
      label: score >= HIGH_THRESHOLD ? 'HIGH' : score >= MEDIUM_THRESHOLD ? 'MEDIUM' : 'LOW',
      score,
      factors,
      caps,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
