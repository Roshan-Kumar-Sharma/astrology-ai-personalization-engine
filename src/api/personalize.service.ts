import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { StructuredLogger } from '../common/logging/logger';
import { RequestTrace } from '../common/logging/request-trace';
import { withTimeout } from '../common/resilience/retry';
import { ConfidenceService } from '../answer/confidence.service';
import { GroundednessService } from '../answer/groundedness.service';
import { LLM_PROVIDER, LlmProvider, LlmResponse } from '../llm/llm.provider';
import { MockLlmProvider } from '../llm/providers/mock.provider';
import { PromptBuilder } from '../llm/prompt/prompt.builder';
import { PersonalizationService } from '../personalization/personalization.service';
import { PersonalizationPlan } from '../personalization/types';
import { GuardrailsService } from '../safety/guardrails.service';
import { ContextAggregator } from '../upstream/context-aggregator.service';
import { ContextBundle } from '../upstream/types';

export interface PersonalizeCommand {
  userId: string;
  question: string;
  verbose?: boolean;
  trace: RequestTrace;
}

export interface PersonalizeResult {
  answer: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  sourcesUsed: string[];
  meta?: Record<string, unknown>;
}

/**
 * The request pipeline.
 *
 * Each stage is a separate service; this class only sequences them and decides
 * what to do when one degrades. Keeping the orchestration free of domain logic
 * is what lets the whole flow be read top to bottom in one screen.
 *
 * Stage order is not arbitrary:
 *   safety first  - a blocked question must never cause an upstream fetch or an
 *                   LLM call. Screening after gathering would leak data and
 *                   spend money on a request we are going to refuse anyway.
 *   gather next   - concurrent, partial-failure tolerant.
 *   plan          - pure, no I/O, fully testable.
 *   generate      - the only expensive call, and it sees only what the plan
 *                   selected.
 *   verify last   - grounding and safety review run on the output before the
 *                   user sees it.
 */
@Injectable()
export class PersonalizeService {
  private readonly mockFallback = new MockLlmProvider();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly guardrails: GuardrailsService,
    private readonly aggregator: ContextAggregator,
    private readonly personalization: PersonalizationService,
    private readonly promptBuilder: PromptBuilder,
    private readonly groundedness: GroundednessService,
    private readonly confidence: ConfidenceService,
    private readonly logger: StructuredLogger,
  ) {}

  async personalize(cmd: PersonalizeCommand): Promise<PersonalizeResult> {
    const { userId, question, trace } = cmd;

    // --- 1. Safety gate, before anything is fetched or spent ------------------
    const guardrail = trace.timeSync('safety.screen', () =>
      this.guardrails.screenQuestion(question),
    );

    if (guardrail.blocked) {
      this.logger.warn('safety.blocked', {
        requestId: trace.requestId,
        userId,
        policies: guardrail.matchedPolicies,
      });
      trace.note(`Blocked by safety policy: ${guardrail.matchedPolicies.join(', ')}`);
      return {
        answer: guardrail.blockResponse ?? FALLBACK_REFUSAL,
        // We are fully confident in the refusal itself; it is not a hedge.
        confidence: 'HIGH',
        sourcesUsed: [],
        meta: cmd.verbose
          ? {
              blocked: true,
              policies: guardrail.matchedPolicies,
              rationale: guardrail.rationale,
              escalateToHuman: guardrail.escalateToHuman,
              latencyMs: trace.totalMs(),
            }
          : undefined,
      };
    }

    // --- 2. Gather -----------------------------------------------------------
    const bundle = await this.aggregator.gather(userId, trace);

    // --- 3. Plan -------------------------------------------------------------
    const plan = this.personalization.plan({ question, bundle, guardrail, trace });

    // --- 4. Generate ---------------------------------------------------------
    const prompt = trace.timeSync('prompt.build', () => this.promptBuilder.build(question, plan));

    this.logger.info('prompt.built', {
      requestId: trace.requestId,
      intent: plan.intent,
      horizon: plan.horizon,
      promptTokens: prompt.tokens.total,
      contextTokens: prompt.tokens.context,
      contextBudget: plan.tokenBudget,
      // The headline optimisation number: what we sent vs what we could have.
      contextTokensAvailable: plan.tokensAvailable,
      naiveBaselineTokens: plan.naiveBaselineTokens,
      contextItemsSelected: plan.selected.length,
      contextItemsExcluded: plan.excluded.length,
    });

    const generation = await trace.time('llm.generate', () => this.generate(prompt, trace));

    // --- 5. Verify -----------------------------------------------------------
    const parsed = this.groundedness.parse(generation.text);
    const report = trace.timeSync('answer.groundedness', () =>
      this.groundedness.verify(parsed, plan.selected),
    );
    const reviewed = trace.timeSync('safety.review', () =>
      this.guardrails.reviewAnswer(parsed.answer),
    );

    if (report.ungroundedEntities.length || report.fabricatedIds.length) {
      this.logger.warn('answer.ungrounded', {
        requestId: trace.requestId,
        ungrounded: report.ungroundedEntities,
        fabricatedIds: report.fabricatedIds,
      });
    }
    if (reviewed.violations.length) {
      this.logger.warn('safety.output_violation', {
        requestId: trace.requestId,
        violations: reviewed.violations,
        replaced: reviewed.replaced,
      });
    }

    const confidence = this.confidence.compute({ bundle, plan, groundedness: report });

    // A degraded provider or a replaced answer must not report full confidence.
    const label =
      generation.degraded || reviewed.replaced ? downgrade(confidence.label) : confidence.label;

    const sourcesUsed = reviewed.replaced
      ? []
      : this.groundedness.sourcesUsed(report, plan.selected);

    this.logger.info('request.completed', {
      requestId: trace.requestId,
      userId,
      intent: plan.intent,
      horizon: plan.horizon,
      confidence: label,
      confidenceScore: confidence.score,
      totalMs: trace.totalMs(),
      latency: trace.latencyBreakdown(),
      provider: generation.provider,
      model: generation.model,
      usage: generation.usage,
      degraded: generation.degraded ?? false,
    });

    return {
      answer: reviewed.answer,
      confidence: label,
      sourcesUsed,
      meta: cmd.verbose
        ? this.buildMeta(plan, prompt.tokens, generation, confidence, report, guardrail, trace)
        : undefined,
    };
  }

  /**
   * Calls the configured provider, falling back to the deterministic local
   * provider if it fails.
   *
   * An astrology answer built offline is a much smaller failure than a 500. The
   * fallback is recorded so the confidence label is downgraded and the event
   * shows up in logs rather than passing silently.
   */
  private async generate(
    prompt: ReturnType<PromptBuilder['build']>,
    trace: RequestTrace,
  ): Promise<LlmResponse> {
    try {
      return await withTimeout(this.cfg.LLM_TIMEOUT_MS, 'llm generate', (signal) =>
        this.llm.generate(prompt, signal),
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.error('llm.failed', {
        requestId: trace.requestId,
        provider: this.llm.name,
        reason,
      });
      trace.note(`LLM provider "${this.llm.name}" failed (${reason}); used the offline fallback.`);
      const fallback = await this.mockFallback.generate(prompt);
      return { ...fallback, degraded: true };
    }
  }

  private buildMeta(
    plan: PersonalizationPlan,
    tokens: ReturnType<PromptBuilder['build']>['tokens'],
    generation: LlmResponse,
    confidence: ReturnType<ConfidenceService['compute']>,
    report: ReturnType<GroundednessService['verify']>,
    guardrail: ReturnType<GuardrailsService['screenQuestion']>,
    trace: RequestTrace,
  ): Record<string, unknown> {
    return {
      requestId: trace.requestId,
      intent: plan.intent,
      horizon: plan.horizon,
      style: plan.style,
      confidence,
      groundedness: report,
      safety: {
        policies: guardrail.matchedPolicies,
        escalateToHuman: guardrail.escalateToHuman,
      },
      tokens: {
        ...tokens,
        contextBudget: plan.tokenBudget,
        contextSelected: plan.tokensUsed,
        contextAvailable: plan.tokensAvailable,
        naiveRawJsonDumpTokens: plan.naiveBaselineTokens,
        contextSavedPct:
          plan.tokensAvailable > 0
            ? Math.round((1 - plan.tokensUsed / plan.tokensAvailable) * 100)
            : 0,
      },
      llm: {
        provider: generation.provider,
        model: generation.model,
        usage: generation.usage,
        degraded: generation.degraded ?? false,
      },
      latency: { totalMs: trace.totalMs(), spans: trace.getSpans() },
    };
  }
}

function downgrade(label: 'HIGH' | 'MEDIUM' | 'LOW'): 'HIGH' | 'MEDIUM' | 'LOW' {
  return label === 'HIGH' ? 'MEDIUM' : 'LOW';
}

const FALLBACK_REFUSAL =
  "I'm not able to help with this one. If you'd like, ask me about what your chart says about this period and I'll work from there.";
