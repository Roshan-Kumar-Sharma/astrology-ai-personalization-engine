import { Injectable } from '@nestjs/common';
import { ChartReliability } from '../astrology/types';
import { Planet } from '../astrology/zodiac';
import {
  CONFIDENCE_MULTIPLIER,
  FOCUS_ADJUSTMENT,
  FOCUS_PROMOTE,
  GOCHAR_PROMOTE,
  HORIZON_ADJUSTMENTS,
  INTENT_RULES,
  matchesAny,
  MIN_SCORE_THRESHOLD,
  STALE_PENALTY,
  TIER_WEIGHTS,
} from './config/intent-rules.config';
import { ContextItem, ExcludedItem, Horizon, Intent, ScoredItem } from './types';

export interface SelectionInput {
  items: ContextItem[];
  intent: Intent;
  secondaryIntents: Intent[];
  horizon: Horizon;
  tokenBudget: number;
  reliability: ChartReliability;
  /** Planets named in the question. Optional so existing callers are unchanged. */
  focus?: Planet[];
  /** "Gochar"/"transit" named without a planet. */
  gochar?: boolean;
}

export interface SelectionResult {
  selected: ScoredItem[];
  excluded: ExcludedItem[];
  tokensUsed: number;
  /** What a naive "send everything" implementation would have spent. */
  tokensAvailable: number;
  notes: string[];
}

/**
 * Turns "here is everything we know" into "here is what this question deserves".
 *
 * The selector contains no knowledge of astrology and no per-intent branching -
 * all of that lives in `intent-rules.config.ts`. Its only job is to apply the
 * rules consistently, which is what makes the engine extensible: a new intent,
 * a new upstream service or a re-tuned weight never touches this file.
 *
 * Order matters. Filters that remove items for correctness reasons (reliability,
 * redundancy, explicit exclusion) run before scoring, so the budget is only ever
 * spent on candidates that are actually admissible.
 */
@Injectable()
export class ContextSelector {
  select(input: SelectionInput): SelectionResult {
    const { items, intent, secondaryIntents, horizon, tokenBudget, reliability } = input;
    const focus = input.focus ?? [];
    const gochar = input.gochar ?? false;
    const rule = INTENT_RULES[intent];
    const override = rule.horizonOverrides?.[horizon];
    const excluded: ExcludedItem[] = [];
    const notes: string[] = [];

    const tokensAvailable = items.reduce((sum, i) => sum + i.tokens, 0);

    if (override?.why) notes.push(`Horizon "${horizon}": ${override.why}`);

    // --- 1. Reliability gate ------------------------------------------------
    // When the birth time cannot support house division, house-based items are
    // not merely low-confidence, they are unsound. They are removed outright
    // rather than down-ranked, because a budget surplus must never be able to
    // let an unsound statement back in.
    let candidates = items;
    if (!reliability.housesUsable) {
      const [kept, dropped] = partition(
        candidates,
        (i) => !/\.house\.\d+$/.test(i.id) && i.id !== 'kundli.lagna',
      );
      candidates = kept;
      for (const d of dropped) {
        excluded.push({
          id: d.id,
          label: d.label,
          reason: 'reliability',
          detail:
            reliability.birthTime === 'unknown'
              ? 'Birth time unknown, so house placements cannot be trusted.'
              : 'Chart failed consistency validation, so house placements are not used.',
        });
      }
      if (dropped.length) {
        notes.push(
          `Suppressed ${dropped.length} house-based item(s); reasoning falls back to the Moon sign.`,
        );
      }
    }

    // --- 2. Redundancy -------------------------------------------------------
    const presentIds = new Set(candidates.map((i) => i.id));
    const superseded = new Map<string, string>();
    for (const i of candidates) {
      for (const target of i.supersedes ?? []) {
        if (presentIds.has(target)) superseded.set(target, i.id);
      }
    }
    if (superseded.size) {
      const [kept, dropped] = partition(candidates, (i) => !superseded.has(i.id));
      candidates = kept;
      for (const d of dropped) {
        excluded.push({
          id: d.id,
          label: d.label,
          reason: 'unavailable',
          detail: `Superseded by ${superseded.get(d.id)}, which already states this fact in fuller form.`,
        });
      }
    }

    // --- 3. Explicit exclusions ---------------------------------------------
    {
      const [kept, dropped] = partition(candidates, (i) => !matchesAny(i.id, rule.exclude));
      candidates = kept;
      for (const d of dropped) {
        excluded.push({
          id: d.id,
          label: d.label,
          reason: 'rule:excluded',
          detail: `Not relevant to a ${intent} question; excluded by rule.`,
        });
      }
    }

    // --- 4. Horizon drops ----------------------------------------------------
    if (override?.drop?.length) {
      const [kept, dropped] = partition(candidates, (i) => !matchesAny(i.id, override.drop!));
      candidates = kept;
      for (const d of dropped) {
        excluded.push({
          id: d.id,
          label: d.label,
          reason: 'rule:horizon-drop',
          detail: override.why ?? `Not meaningful over a "${horizon}" horizon.`,
        });
      }
    }

    // --- 5. Scoring ----------------------------------------------------------
    const scored: ScoredItem[] = candidates.map((i) =>
      this.score(i, { rule, secondaryIntents, override, focus, gochar }),
    );

    // --- 6. Relevance floor ---------------------------------------------------
    // Applied before packing, so a large budget can never pull in background
    // material. Budget decides how much of the relevant set fits, never what
    // counts as relevant.
    const relevant: ScoredItem[] = [];
    for (const s of scored) {
      if (s.score >= MIN_SCORE_THRESHOLD) {
        relevant.push(s);
      } else {
        excluded.push({
          id: s.id,
          label: s.label,
          reason: 'rule:below-threshold',
          detail: `Scored ${s.score}, below the relevance floor of ${MIN_SCORE_THRESHOLD} for a ${intent} question.`,
        });
      }
    }

    // Priority first; cheaper items break ties so the budget stretches further.
    relevant.sort((a, b) => b.score - a.score || a.tokens - b.tokens);

    // --- 7. Budget packing ---------------------------------------------------
    // Greedy by priority, but a single expensive item that does not fit must not
    // block every cheaper item behind it - so packing continues past a miss
    // rather than stopping at the first overflow.
    const selected: ScoredItem[] = [];
    let tokensUsed = 0;
    for (const candidate of relevant) {
      if (tokensUsed + candidate.tokens <= tokenBudget) {
        selected.push(candidate);
        tokensUsed += candidate.tokens;
      } else {
        excluded.push({
          id: candidate.id,
          label: candidate.label,
          reason: 'budget',
          detail: `Ranked ${Math.round(candidate.score)} but did not fit the ${tokenBudget}-token budget (${tokensUsed} used).`,
        });
      }
    }

    // An empty context produces an ungrounded answer, which is the one outcome
    // worse than an over-budget one. Force the single best item through.
    if (!selected.length && relevant.length) {
      const best = relevant[0];
      selected.push(best);
      tokensUsed = best.tokens;
      const idx = excluded.findIndex((e) => e.id === best.id && e.reason === 'budget');
      if (idx >= 0) excluded.splice(idx, 1);
      notes.push(
        `Budget of ${tokenBudget} tokens could not fit any item; forced the highest-ranked one to avoid an ungrounded answer.`,
      );
    }

    return { selected, excluded, tokensUsed, tokensAvailable, notes };
  }

  private score(
    item: ContextItem,
    ctx: {
      rule: (typeof INTENT_RULES)[Intent];
      secondaryIntents: Intent[];
      override?: { promote?: string[]; demote?: string[] };
      focus: Planet[];
      gochar: boolean;
    },
  ): ScoredItem {
    const { rule, secondaryIntents, override, focus, gochar } = ctx;
    const reasons: string[] = [];

    let tier: ScoredItem['tier'] = 'neutral';
    if (matchesAny(item.id, rule.primary)) {
      tier = 'primary';
      reasons.push(`primary source for ${rule.intent}`);
    } else if (matchesAny(item.id, rule.secondary)) {
      tier = 'secondary';
      reasons.push(`secondary source for ${rule.intent}`);
    }

    // A compound question ("a loan for a new job") should not discard the
    // second topic. Items that are primary for a detected secondary intent are
    // lifted to secondary weight rather than left as background noise.
    if (tier === 'neutral') {
      for (const si of secondaryIntents) {
        if (matchesAny(item.id, INTENT_RULES[si].primary)) {
          tier = 'secondary';
          reasons.push(`primary source for secondary intent ${si}`);
          break;
        }
      }
    }

    let score: number = TIER_WEIGHTS[tier];

    if (override?.promote && matchesAny(item.id, override.promote)) {
      score += HORIZON_ADJUSTMENTS.promote;
      reasons.push('promoted for this time horizon');
    }
    if (override?.demote && matchesAny(item.id, override.demote)) {
      score += HORIZON_ADJUSTMENTS.demote;
      reasons.push('demoted for this time horizon');
    }

    // A planet named in the question outranks anything a life-area rule can
    // infer. Applied once, whichever planet matched first.
    const named = focus.find((p) => matchesAny(item.id, FOCUS_PROMOTE[p] ?? []));
    if (named) {
      score += FOCUS_ADJUSTMENT;
      reasons.push(`promoted: the question names ${named}`);
    } else if (gochar && matchesAny(item.id, GOCHAR_PROMOTE)) {
      score += FOCUS_ADJUSTMENT;
      reasons.push('promoted: the question asks about transits');
    }

    // A promotion may lift a secondary or background item *to* primary weight,
    // never past it. The facts an intent names as primary are the ones that
    // answer the question; a horizon or a named planet can add to them but
    // must not bury them. Without this, promoting the Saturn transit at a
    // quarter horizon (55 + 60 = 115) pushed the dasha transition - the actual
    // answer to "should I change my job in the next few months" - out of the
    // lead of the prompt.
    if (tier !== 'primary' && score > TIER_WEIGHTS.primary) {
      score = TIER_WEIGHTS.primary;
      reasons.push('capped at primary weight');
    }

    const confMultiplier = CONFIDENCE_MULTIPLIER[item.confidence];
    if (confMultiplier !== 1) reasons.push(`${item.confidence}-confidence data`);
    score *= confMultiplier;

    if (item.stale) {
      score *= STALE_PENALTY;
      reasons.push('served from stale cache');
    }

    if (tier === 'neutral' && !reasons.length) reasons.push('background context');

    return {
      ...item,
      score: Math.max(0, Math.round(score * 10) / 10),
      tier,
      reason: reasons.join('; '),
    };
  }
}

function partition<T>(arr: T[], pred: (t: T) => boolean): [T[], T[]] {
  const yes: T[] = [];
  const no: T[] = [];
  for (const t of arr) (pred(t) ? yes : no).push(t);
  return [yes, no];
}
