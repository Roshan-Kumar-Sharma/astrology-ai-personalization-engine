/**
 * Offline evaluation harness.
 *
 * Runs the real pipeline - the same classifier, extractor, inference engine,
 * selector and guardrails the API uses - with no HTTP and no LLM. Bundles are
 * assembled straight from the mock fixtures, so a full 200-case sweep costs
 * milliseconds and is safe to run in CI on every push.
 *
 * The deliberate omission is generation. Everything scored here is a decision
 * the engine makes *before* a token is spent, which is exactly the part that
 * has to be deterministic. Answer quality needs a judge and a budget; see
 * eval/README.md for why that is a separate, opt-in tier.
 */
import { AppConfig, loadConfig } from '../src/common/config/app.config';
import { RequestTrace } from '../src/common/logging/request-trace';
import { AstrologyInferenceEngine } from '../src/astrology/inference.service';
import { ContextItemBuilder } from '../src/personalization/context-item.builder';
import { ContextSelector } from '../src/personalization/context.selector';
import { IntentClassifier } from '../src/personalization/intent/intent.classifier';
import { PersonalizationService } from '../src/personalization/personalization.service';
import { StyleResolver } from '../src/personalization/style.resolver';
import type { PersonalizationPlan } from '../src/personalization/types';
import { GuardrailsService } from '../src/safety/guardrails.service';
import { HOROSCOPES, KUNDLIS, USERS, panchangFor } from '../src/upstream/mock/fixtures';
import type { ContextBundle, SourceResult, UpstreamName } from '../src/upstream/types';

/** A fixed date keeps panchang-dependent selection reproducible across runs. */
export const EVAL_DATE = '2026-09-15';

const CFG: AppConfig = loadConfig({ ...process.env, LLM_PROVIDER: 'mock', LOG_LEVEL: 'error' });

function ok<T>(source: UpstreamName, data: T): SourceResult<T> {
  return { source, outcome: 'ok', data, latencyMs: 0, attempts: 1 };
}

/**
 * A bundle as the aggregator would have returned it on a fully healthy day.
 *
 * Degraded paths are covered by the unit and e2e suites; holding every source
 * "ok" here isolates the variable under test, so a selection miss is a rules
 * problem rather than an availability artefact.
 */
export function bundleFor(userId: string): ContextBundle {
  const user = USERS[userId];
  if (!user) throw new Error(`eval: unknown fixture user "${userId}"`);
  return {
    user: ok('user', user),
    kundli: ok('kundli', KUNDLIS[userId]),
    horoscope: ok('horoscope', HOROSCOPES[userId]),
    panchang: ok('panchang', panchangFor(EVAL_DATE)),
  };
}

export const guardrails = new GuardrailsService();

const engine = new PersonalizationService(
  CFG,
  new IntentClassifier(),
  new AstrologyInferenceEngine(),
  new ContextItemBuilder(),
  new ContextSelector(),
  new StyleResolver(),
);

/** The plan the engine would build for this question, minus generation. */
export function planFor(question: string, userId = 'user_101'): PersonalizationPlan {
  return engine.plan({
    question,
    bundle: bundleFor(userId),
    guardrail: guardrails.screenQuestion(question),
    trace: new RequestTrace('eval'),
  });
}
