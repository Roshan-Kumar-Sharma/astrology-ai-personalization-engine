import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { RequestTrace } from '../common/logging/request-trace';
import { AstrologyInferenceEngine } from '../astrology/inference.service';
import { GuardrailDecision } from '../safety/guardrails.service';
import { ContextBundle } from '../upstream/types';
import { INTENT_RULES } from './config/intent-rules.config';
import { ContextItemBuilder } from './context-item.builder';
import { ContextSelector } from './context.selector';
import { extractFocus } from './intent/focus.extractor';
import { extractHorizon } from './intent/horizon.extractor';
import { IntentClassifier } from './intent/intent.classifier';
import { StyleResolver } from './style.resolver';
import { PersonalizationPlan, IntentResult } from './types';
import { estimateJsonTokens } from '../llm/tokenizer';

/**
 * What a "just send everything" implementation would put in the prompt: every
 * upstream document, serialised as-is.
 */
function naiveBaseline(bundle: ContextBundle): number {
  return (
    estimateJsonTokens(bundle.user.data ?? {}) +
    estimateJsonTokens(bundle.kundli.data ?? {}) +
    estimateJsonTokens(bundle.horoscope.data ?? {}) +
    estimateJsonTokens(bundle.panchang.data ?? {}) +
    estimateJsonTokens(bundle.transit.data ?? {})
  );
}

export interface PlanInput {
  question: string;
  bundle: ContextBundle;
  guardrail: GuardrailDecision;
  /**
   * Intent resolved upstream, when the pipeline escalated to the LLM.
   *
   * Omitted, the engine classifies with the lexicon itself. That fallback is
   * what keeps `plan()` synchronous and LLM-free, and it is why the golden eval
   * can sweep 249 cases in a second.
   */
  intent?: IntentResult;
  trace: RequestTrace;
}

/**
 * The Personalization Engine.
 *
 * Composes the stages that decide *what this particular question deserves*:
 * what is being asked, over what time frame, which facts can be inferred, what
 * is admissible, what fits the budget, and how the answer should sound.
 *
 * Deliberately produces no prose and calls no LLM. Its whole output is a plan -
 * which is why the debug endpoint can show the engine's reasoning without
 * spending a token, and why every decision here is unit-testable in isolation.
 */
@Injectable()
export class PersonalizationService {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly classifier: IntentClassifier,
    private readonly inference: AstrologyInferenceEngine,
    private readonly itemBuilder: ContextItemBuilder,
    private readonly selector: ContextSelector,
    private readonly styleResolver: StyleResolver,
  ) {}

  plan(input: PlanInput): PersonalizationPlan {
    const { question, bundle, guardrail, trace } = input;

    // --- 1. What is being asked, and over what window? -----------------------
    const intentResult =
      input.intent ?? trace.timeSync('intent.classify', () => this.classifier.classify(question));
    const { horizon, signal } = trace.timeSync('intent.horizon', () => extractHorizon(question));

    trace.note(
      `Intent "${intentResult.intent}" (${intentResult.method}, confidence ${intentResult.confidence})` +
        (intentResult.signals.length ? ` from: ${intentResult.signals.join(', ')}` : ''),
    );
    trace.note(
      signal
        ? `Time horizon "${horizon}" from the phrase "${signal}".`
        : 'No explicit time frame in the question; treating it as near-term.',
    );
    const focus = trace.timeSync('intent.focus', () => extractFocus(question));
    if (focus.planets.length || focus.gochar) {
      trace.note(
        `Question names ${focus.planets.length ? focus.planets.join(', ') : 'the transits'} ` +
          `(from: ${focus.signals.join(', ')}); those transit facts are promoted.`,
      );
    }

    const rule = INTENT_RULES[intentResult.intent];

    // --- 2. Derive conclusions before selecting ------------------------------
    // Order matters: derived facts are selectable context, so they must exist
    // before selection runs, and the categories they are computed for come from
    // the intent rule.
    const { facts, reliability } = trace.timeSync('astrology.infer', () =>
      this.inference.derive({
        user: bundle.user.data,
        kundli: bundle.kundli.data,
        panchang: bundle.panchang.data,
        transits: bundle.transit.data,
        categories: rule.categories,
      }),
    );

    for (const note of reliability.notes) trace.note(note);
    for (const bad of reliability.inconsistencies) {
      trace.note(`Chart validation failure: ${bad}`);
    }

    // --- 3. How should the answer sound? -------------------------------------
    const style = this.styleResolver.resolve(bundle.user.data, intentResult.intent, horizon);
    if (bundle.user.outcome === 'failed') {
      trace.note('User profile unavailable; falling back to default language, tone and length.');
    }

    // --- 4. Select ------------------------------------------------------------
    const items = this.itemBuilder.build(bundle, facts);
    const tokenBudget =
      style.tier === 'premium'
        ? this.cfg.CONTEXT_TOKEN_BUDGET_PREMIUM
        : this.cfg.CONTEXT_TOKEN_BUDGET_FREE;

    const selection = trace.timeSync('context.select', () =>
      this.selector.select({
        items,
        intent: intentResult.intent,
        secondaryIntents: intentResult.secondary,
        horizon,
        tokenBudget,
        reliability,
        focus: focus.planets,
        gochar: focus.gochar,
      }),
    );

    for (const note of selection.notes) trace.note(note);

    return {
      intent: intentResult.intent,
      intentConfidence: intentResult.confidence,
      intentMethod: intentResult.method,
      secondaryIntents: intentResult.secondary,
      horizon,
      focus: focus.planets,
      style,
      selected: selection.selected,
      excluded: selection.excluded,
      tokenBudget,
      tokensUsed: selection.tokensUsed,
      tokensAvailable: selection.tokensAvailable,
      naiveBaselineTokens: naiveBaseline(bundle),
      reliability,
      constraints: guardrail.constraints,
      notes: trace.getNotes(),
    };
  }
}
