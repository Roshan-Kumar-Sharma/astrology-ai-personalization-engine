import { Body, Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { RequestTrace } from '../common/logging/request-trace';
import { StructuredLogger } from '../common/logging/logger';
import { ConfidenceService } from '../answer/confidence.service';
import { PersonalizationService } from '../personalization/personalization.service';
import { GuardrailsService } from '../safety/guardrails.service';
import { PromptBuilder } from '../llm/prompt/prompt.builder';
import { ContextAggregator } from '../upstream/context-aggregator.service';
import { INTENT_RULES } from '../personalization/config/intent-rules.config';
import { PersonalizeRequestDto } from './dto/personalize.dto';
import { DebugEnabledGuard } from './debug-enabled.guard';

@Controller('debug')
@UseGuards(DebugEnabledGuard)
export class DebugController {
  constructor(
    private readonly guardrails: GuardrailsService,
    private readonly aggregator: ContextAggregator,
    private readonly personalization: PersonalizationService,
    private readonly promptBuilder: PromptBuilder,
    private readonly confidence: ConfidenceService,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * POST /debug/personalization
   *
   * Runs the entire engine except generation, and explains itself.
   *
   * This is the same code path /personalize takes, not a parallel
   * reimplementation - so what it shows is necessarily what actually happens.
   * It answers "why did the user get that answer?" without spending a token,
   * which makes it the endpoint you actually reach for during an incident.
   */
  @Post('personalization')
  @HttpCode(200)
  async explain(
    @Body() body: PersonalizeRequestDto,
    @Headers('x-request-id') requestId?: string,
  ): Promise<Record<string, unknown>> {
    const trace = new RequestTrace(requestId);
    const guardrail = this.guardrails.screenQuestion(body.question);
    const bundle = await this.aggregator.gather(body.userId, trace);
    const plan = this.personalization.plan({ question: body.question, bundle, guardrail, trace });

    // Built but never sent - lets us report the exact prompt size and preview
    // the text the model would have received.
    const prompt = this.promptBuilder.build(body.question, plan);
    const confidence = this.confidence.compute({ bundle, plan });
    const rule = INTENT_RULES[plan.intent];
    const selectedLabels = dedupe(plan.selected.map((i) => i.displayGroup ?? i.label));

    this.logger.info('debug.explained', {
      requestId: trace.requestId,
      intent: plan.intent,
      horizon: plan.horizon,
      promptTokens: prompt.tokens.total,
    });

    return {
      // --- the shape the brief asks for -----------------------------------
      intent: plan.intent,
      selectedContext: selectedLabels,
      // A label can appear on both lists when a raw field was superseded by the
      // derived fact that restates it ("10th House" excluded as redundant while
      // "10th House" is selected). That is an internal optimisation, not a
      // selection decision, so it is filtered out of the summary view. The full
      // record, superseded entries included, stays in `explain.excluded`.
      excludedContext: dedupe(plan.excluded.map((i) => i.label)).filter(
        (label) => !selectedLabels.includes(label),
      ),
      language: plan.style.language,
      tone: capitalize(plan.style.tone),

      // --- everything needed to actually explain the decision --------------
      explain: {
        requestId: trace.requestId,
        question: body.question,
        intentDetection: {
          intent: plan.intent,
          confidence: plan.intentConfidence,
          method: plan.intentMethod,
          secondaryIntents: plan.secondaryIntents,
          rule: rule.description,
        },
        timeHorizon: {
          horizon: plan.horizon,
          effect:
            rule.horizonOverrides?.[plan.horizon]?.why ??
            'No horizon-specific adjustment applies to this intent.',
        },
        responseStyle: plan.style,
        chartReliability: plan.reliability,
        selected: plan.selected.map((i) => ({
          id: i.id,
          label: i.label,
          source: i.source,
          tier: i.tier,
          score: i.score,
          tokens: i.tokens,
          why: i.reason,
          text: i.text,
        })),
        excluded: plan.excluded.map((i) => ({
          id: i.id,
          label: i.label,
          reason: i.reason,
          detail: i.detail,
        })),
        tokenBudget: {
          budget: plan.tokenBudget,
          contextTokensUsed: plan.tokensUsed,
          contextTokensAvailable: plan.tokensAvailable,
          naiveRawJsonDumpTokens: plan.naiveBaselineTokens,
          vsNaiveDumpPct:
            plan.naiveBaselineTokens > 0
              ? Math.round((1 - plan.tokensUsed / plan.naiveBaselineTokens) * 100)
              : 0,
          savedPct:
            plan.tokensAvailable > 0
              ? Math.round((1 - plan.tokensUsed / plan.tokensAvailable) * 100)
              : 0,
          promptTokens: prompt.tokens,
        },
        safety: {
          blocked: guardrail.blocked,
          policies: guardrail.matchedPolicies,
          rationale: guardrail.rationale,
          injectedConstraints: guardrail.constraints,
          escalateToHuman: guardrail.escalateToHuman,
        },
        upstream: Object.fromEntries(
          Object.values(bundle).map((r) => [
            r.source,
            { outcome: r.outcome, latencyMs: r.latencyMs, attempts: r.attempts, error: r.error },
          ]),
        ),
        projectedConfidence: confidence,
        notes: plan.notes,
        latency: { totalMs: trace.totalMs(), spans: trace.getSpans() },
        promptPreview: `${prompt.systemStatic}\n\n---\n\n${prompt.systemDynamic}\n\n---\n\n${prompt.messages[0].content}`,
      },
    };
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function capitalize(s: string): string {
  return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}
