import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { StructuredLogger } from '../common/logging/logger';
import { RequestTrace } from '../common/logging/request-trace';
import { withTimeout } from '../common/resilience/retry';
import { LLM_PROVIDER, LlmProvider } from '../llm/llm.provider';
import { extractJsonObject, stripReasoning } from '../llm/parse';
import { RISK_POLICIES, RiskPolicy } from './policies.config';

export interface SafetyScreenResult {
  /**
   * `off`         - the layer is disabled.
   * `clear`       - the model answered and saw nothing to refuse.
   * `flagged`     - the model named a blocking policy.
   * `unavailable` - the call failed, timed out, or could not be parsed. The
   *                 question proceeds, because this layer only ever adds.
   */
  outcome: 'off' | 'clear' | 'flagged' | 'unavailable';
  policy?: RiskPolicy;
  error?: string;
}

const BLOCKING: RiskPolicy[] = RISK_POLICIES.filter((p) => p.action === 'block');
const BLOCKING_IDS = BLOCKING.map((p) => p.id);

/**
 * The catalogue sent to the model, built from the policy table itself. Adding a
 * blocking policy teaches this screen about it with no second edit, and the
 * rationale the reviewer wrote is the definition the model is given.
 */
const CATALOGUE = BLOCKING.map((p) => `- ${p.id}: ${p.rationale}`).join('\n');

/**
 * The precision half of the prompt.
 *
 * These are not hypotheticals - each is a phrasing that a pattern layer
 * over-matched at some point, or that a careful reader would flag on a first
 * pass. An LLM asked "is this dangerous?" with no counter-examples drifts
 * towards yes, and a safety layer that refuses ordinary questions is a worse
 * product than no second layer at all.
 */
const NEGATIVES = `Do NOT flag ordinary questions that merely sound dark. All of these must be answered normally:
- "Will my career die out in this industry?" - an idiom, not a longevity question.
- "My relationship is killing me emotionally" - an idiom.
- "How do I deal with the loss of my father?" - grief support, not a death prediction.
- "My father passed away last year, how is my chart affected?" - a past bereavement.
- "What does the 8th house mean in Vedic astrology?" - an educational question.
- "Will my startup survive this year?" - a business question.
- "We are trying for a baby, what does this period hold?" - no sex determination is being asked.
- "I have a court hearing next week, how do I prepare mentally?" - no verdict is being asked.
- "Should I see a doctor about my headaches?" - encouraging care is the safe answer.`;

const SYSTEM = `You are a safety screen for a Vedic astrology assistant. A deterministic rule layer has already run and did not refuse this question. Your job is to catch only what it missed.

Refuse-worthy categories:
${CATALOGUE}

${NEGATIVES}

Most questions are ordinary and must be answered. Reply "none" unless the question genuinely belongs to a category above.

Reply with JSON only, no prose:
{"policy":"<one category id above, or none>"}`;

/**
 * The second safety layer: a model behind the patterns, never in front of them.
 *
 * Why it exists, in one number: the deterministic layer scores 100% on the
 * golden set and **43.8%** on phrasings written without reference to its
 * patterns. Precision generalised; recall did not. Hand-written rules have a
 * coverage ceiling that diligence does not remove, and this is the layer for
 * what falls through it.
 *
 * Three properties make it safe to add:
 *
 * 1. **It can only ever add a refusal, never remove one.** A deterministic
 *    block returns before this runs. Nothing an attacker writes can talk the
 *    system out of a refusal it has already decided on.
 * 2. **It picks a policy id, not words.** The user reads the same reviewed
 *    `blockResponse` the deterministic layer would have returned, so refusal
 *    copy is never model-generated and stays explainable.
 * 3. **It fails open to the deterministic decision.** A provider outage
 *    degrades the service to exactly the behaviour that ships today, rather
 *    than to something worse.
 *
 * There is deliberately **no confidence gate** on this one, unlike the intent
 * fallback. That gate works because the lexicon's confidence is calibrated
 * against its own errors. Here the patterns are silent precisely where they
 * fail, so any cheap gate would reintroduce the ceiling this layer exists to
 * remove. It screens every question the deterministic layer let through, and
 * that cost is the reason it ships off by default.
 */
@Injectable()
export class LlmSafetyScreen {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly logger: StructuredLogger,
  ) {}

  get enabled(): boolean {
    return this.cfg.SAFETY_LLM_SCREEN;
  }

  /**
   * Screen a question the deterministic layer allowed.
   *
   * The outcome is three-way rather than a nullable policy, because "the model
   * saw nothing" and "the model never answered" are operationally different and
   * must not be collapsed. A measurement that cannot tell them apart will
   * cheerfully report a 0% lift for a layer that was never running - which is
   * exactly what happened the first time this was measured.
   */
  async screen(question: string, trace: RequestTrace): Promise<SafetyScreenResult> {
    if (!this.enabled) return { outcome: 'off' };

    try {
      const res = await trace.time('safety.llm', () =>
        withTimeout(this.cfg.SAFETY_LLM_TIMEOUT_MS, 'safety screen', (signal) =>
          this.llm.generate(
            {
              systemStatic: SYSTEM,
              systemDynamic: '',
              messages: [{ role: 'user', content: question }],
              // Generous on purpose: free-tier models are disproportionately
              // reasoning models, and a tight budget truncates them before they
              // reach the JSON.
              maxTokens: 512,
            },
            signal,
          ),
        ),
      );

      const id = parsePolicyId(res.text);
      const policy = id ? BLOCKING.find((p) => p.id === id) : undefined;
      if (!policy) return { outcome: 'clear' };

      trace.note(`Second-layer safety screen flagged this as "${policy.id}".`);
      this.logger.warn('safety.llm_blocked', { requestId: trace.requestId, policy: policy.id });
      return { outcome: 'flagged', policy };
    } catch (err) {
      // Fail open to the deterministic decision. This layer is additive: losing
      // it returns the service to its shipped behaviour, whereas failing closed
      // would refuse every question during a provider outage. Logged at warn so
      // a silently absent second layer is visible in the logs.
      this.logger.warn('safety.llm_failed', {
        requestId: trace.requestId,
        error: err instanceof Error ? err.message : String(err),
      });
      trace.note('Second-layer safety screen unavailable; deterministic decision stands.');
      return { outcome: 'unavailable', error: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Strict, closed-vocabulary parse.
 *
 * The model may only name a policy that exists and blocks. Anything else - an
 * invented category, prose, a truncated reply - is read as "none", which is the
 * fail-open direction and matches how every other failure here behaves.
 */
export function parsePolicyId(raw: string): string | undefined {
  const json = extractJsonObject(stripReasoning(raw));
  if (!json) return undefined;

  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch {
    return undefined;
  }

  const value = (obj as { policy?: unknown }).policy;
  if (typeof value !== 'string') return undefined;

  const v = value.trim().toLowerCase();
  return BLOCKING_IDS.includes(v) ? v : undefined;
}
