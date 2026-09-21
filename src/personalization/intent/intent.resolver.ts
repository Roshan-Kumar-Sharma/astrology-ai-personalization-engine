import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../../common/config/app.config';
import { StructuredLogger } from '../../common/logging/logger';
import { RequestTrace } from '../../common/logging/request-trace';
import { withTimeout } from '../../common/resilience/retry';
import { LLM_PROVIDER, LlmProvider } from '../../llm/llm.provider';
import { extractJsonObject, stripReasoning } from '../../llm/parse';
import { INTENT_RULES } from '../config/intent-rules.config';
import { Intent, IntentResult } from '../types';
import { IntentClassifier } from './intent.classifier';

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
 * The taxonomy sent to the model, built from the same `description` fields the
 * selector uses. One source of truth: editing a rule's description updates the
 * classifier prompt, so the two can never drift into disagreeing about what
 * "finance" means.
 */
const TAXONOMY = ALL_INTENTS.map((i) => `- ${i}: ${INTENT_RULES[i].description}`).join('\n');

const SYSTEM = `You classify a user's question to an astrology assistant into exactly one intent.

Intents:
${TAXONOMY}

Rules:
- Choose the single intent the question is primarily about.
- "general" is for genuinely open-ended questions only. Prefer a specific intent whenever the question has a clear subject.
- A time word ("today", "this week") does not make a question "daily" if it has a topic. "How is this week for my marriage?" is relationship.
- List any clearly-present additional topics in "secondary".

Reply with JSON only, no prose:
{"intent":"<one of the intents above>","secondary":["<zero or more other intents>"]}`;

/**
 * Confidence assigned to an accepted LLM classification.
 *
 * Below the strong-lexicon band on purpose. The model resolved a question the
 * lexicon could not, which is worth something, but it is one unverifiable
 * opinion - and confidence here feeds the answer's confidence score, which is
 * meant to be computed from measurable factors rather than asserted.
 */
const LLM_CONFIDENCE = 0.7;

/**
 * Lexicon first, LLM only for the genuinely ambiguous tail.
 *
 * Why this is a separate service and not a branch inside `IntentClassifier`:
 * the classifier is synchronous, pure and free, and the whole engine depends on
 * it staying that way - `PersonalizationService.plan()` calls no LLM by design.
 * So escalation happens *above* the engine, in the pipeline, and the resolved
 * intent is handed down. The engine keeps working unchanged with no resolver at
 * all, which is also what lets the golden eval run 249 cases in a second.
 *
 * The gate is measured, not guessed. On the golden set, escalating only the
 * questions where the lexicon found no signal at all (confidence 0.3) is 34% of
 * traffic and contains 66% of every intent error - see docs/11.
 */
@Injectable()
export class IntentResolver {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly lexicon: IntentClassifier,
    private readonly logger: StructuredLogger,
  ) {}

  async resolve(question: string, trace: RequestTrace): Promise<IntentResult> {
    const lex = trace.timeSync('intent.classify', () => this.lexicon.classify(question));

    if (!this.cfg.INTENT_LLM_FALLBACK) return lex;
    if (lex.confidence >= this.cfg.INTENT_LLM_THRESHOLD) return lex;

    trace.note(
      `Intent confidence ${lex.confidence} is below the ${this.cfg.INTENT_LLM_THRESHOLD} escalation threshold; asking the model.`,
    );

    try {
      const escalated = await trace.time('intent.llm', () => this.askModel(question));
      if (!escalated) return lex;

      trace.note(`Model classified this as "${escalated.intent}" (lexicon said "${lex.intent}").`);
      return escalated;
    } catch (err) {
      // Intent is never worth failing a request over: the lexicon already
      // produced a usable answer, and a degraded intent costs relevance, not
      // correctness. Safety ran before this and does not depend on it.
      this.logger.warn('intent.llm.failed', {
        requestId: trace.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      trace.note('Intent escalation failed; keeping the lexicon result.');
      return lex;
    }
  }

  private async askModel(question: string): Promise<IntentResult | undefined> {
    const res = await withTimeout(this.cfg.INTENT_LLM_TIMEOUT_MS, 'intent classify', (signal) =>
      this.llm.generate(
        {
          systemStatic: SYSTEM,
          systemDynamic: '',
          messages: [{ role: 'user', content: question }],
          // Far more than the output needs. Free-tier models are
          // disproportionately reasoning models, and a tight budget truncates
          // them mid-thought - so they never reach the JSON at all.
          maxTokens: 512,
        },
        signal,
      ),
    );

    const parsed = parseIntent(res.text);
    if (!parsed) return undefined;

    return {
      intent: parsed.intent,
      confidence: LLM_CONFIDENCE,
      secondary: parsed.secondary,
      method: 'llm',
      signals: [],
    };
  }
}

/**
 * Strict parse: the model may only pick from the taxonomy.
 *
 * Anything else - an invented intent, prose, a truncated response - returns
 * undefined and the lexicon result stands. A classifier that can return a value
 * the selector has no rule for would fail deeper in the pipeline and harder.
 */
export function parseIntent(raw: string): { intent: Intent; secondary: Intent[] } | undefined {
  const text = stripReasoning(raw);
  const json = extractJsonObject(text);
  if (!json) return undefined;

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return undefined;
  }

  const record = obj as { intent?: unknown; secondary?: unknown };
  const intent = asIntent(record.intent);
  if (!intent) return undefined;

  const secondary = Array.isArray(record.secondary)
    ? [...new Set(record.secondary.map(asIntent).filter((i): i is Intent => !!i && i !== intent))]
    : [];

  return { intent, secondary };
}

function asIntent(value: unknown): Intent | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return (ALL_INTENTS as string[]).includes(v) ? (v as Intent) : undefined;
}
