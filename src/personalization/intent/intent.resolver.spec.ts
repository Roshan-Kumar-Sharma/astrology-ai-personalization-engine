import { AppConfig, loadConfig } from '../../common/config/app.config';
import { StructuredLogger } from '../../common/logging/logger';
import { RequestTrace } from '../../common/logging/request-trace';
import { LlmProvider, LlmRequest, LlmResponse } from '../../llm/llm.provider';
import { IntentClassifier } from './intent.classifier';
import { IntentResolver, parseIntent } from './intent.resolver';

class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  calls = 0;
  constructor(private readonly behaviour: () => string | Promise<string>) {}
  async generate(_req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    const text = await this.behaviour();
    return { text, model: this.model, provider: this.name, latencyMs: 1 };
  }
}

const logger = new StructuredLogger();
logger.setLevel('error');

const cfg = (over: Partial<Record<string, string>> = {}): AppConfig =>
  loadConfig({ LLM_PROVIDER: 'mock', LOG_LEVEL: 'error', ...over } as never);

const resolve = (
  provider: FakeProvider,
  over: Partial<Record<string, string>> = {},
  q = 'Is it a good time?',
) =>
  new IntentResolver(cfg(over), provider, new IntentClassifier(), logger).resolve(
    q,
    new RequestTrace('t'),
  );

describe('IntentResolver', () => {
  /** A question with no lexical signal at all: the classifier returns 0.3. */
  const AMBIGUOUS = 'Is it a good time?';
  /** Unambiguously career: the lexicon is confident and must not escalate. */
  const CLEAR = 'Should I change my job this month?';

  it('never calls the model when the fallback is off', async () => {
    const p = new FakeProvider(() => '{"intent":"career"}');
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'false' });
    expect(p.calls).toBe(0);
    expect(r.method).toBe('default');
  });

  it('does not escalate a question the lexicon is confident about', async () => {
    const p = new FakeProvider(() => '{"intent":"health"}');
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'true' }, CLEAR);
    expect(p.calls).toBe(0);
    expect(r.intent).toBe('career');
    expect(r.method).toBe('lexicon');
  });

  it('escalates the ambiguous tail and adopts the model answer', async () => {
    const p = new FakeProvider(() => '{"intent":"spiritual","secondary":["health"]}');
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'true' }, AMBIGUOUS);
    expect(p.calls).toBe(1);
    expect(r.intent).toBe('spiritual');
    expect(r.secondary).toEqual(['health']);
    expect(r.method).toBe('llm');
  });

  /**
   * Every failure mode below must land on the lexicon result rather than an
   * exception. Intent is a relevance decision: degrading it costs a less
   * well-targeted answer, and failing the request costs the user everything.
   * Safety already ran, and does not depend on intent.
   */
  it('keeps the lexicon result when the model throws', async () => {
    const p = new FakeProvider(() => {
      throw new Error('502 from provider');
    });
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'true' });
    expect(r.method).toBe('default');
    expect(r.intent).toBe('general');
  });

  it('keeps the lexicon result when the model times out', async () => {
    const p = new FakeProvider(
      () => new Promise((res) => setTimeout(() => res('{"intent":"career"}'), 200)),
    );
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'true', INTENT_LLM_TIMEOUT_MS: '20' });
    expect(r.method).toBe('default');
  });

  it('keeps the lexicon result when the model invents an intent', async () => {
    const p = new FakeProvider(() => '{"intent":"astrology","secondary":[]}');
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'true' });
    expect(r.intent).toBe('general');
    expect(r.method).toBe('default');
  });

  it('keeps the lexicon result when the model replies with prose', async () => {
    const p = new FakeProvider(() => 'I think this is probably a career question!');
    const r = await resolve(p, { INTENT_LLM_FALLBACK: 'true' });
    expect(r.method).toBe('default');
  });

  it('honours a raised threshold', async () => {
    const p = new FakeProvider(() => '{"intent":"finance"}');
    const r = await resolve(
      p,
      { INTENT_LLM_FALLBACK: 'true', INTENT_LLM_THRESHOLD: '0.99' },
      CLEAR,
    );
    expect(p.calls).toBe(1);
    expect(r.intent).toBe('finance');
  });
});

describe('parseIntent', () => {
  it('accepts a clean object', () => {
    expect(parseIntent('{"intent":"career","secondary":["finance"]}')).toEqual({
      intent: 'career',
      secondary: ['finance'],
    });
  });

  /**
   * Free-tier models are disproportionately reasoning models, and several emit
   * their thinking as ordinary content. Left in, it buries the JSON.
   */
  it('strips visible chain-of-thought', () => {
    expect(parseIntent('<think>hmm, jobs…</think>{"intent":"career"}')?.intent).toBe('career');
  });

  it('tolerates markdown fences', () => {
    expect(parseIntent('```json\n{"intent":"health"}\n```')?.intent).toBe('health');
  });

  it('is case-insensitive and trims', () => {
    expect(parseIntent('{"intent":" Career "}')?.intent).toBe('career');
  });

  it('drops a secondary that repeats the primary', () => {
    expect(parseIntent('{"intent":"career","secondary":["career","finance"]}')?.secondary).toEqual([
      'finance',
    ]);
  });

  it('rejects invented intents, prose and truncation', () => {
    expect(parseIntent('{"intent":"astrology"}')).toBeUndefined();
    expect(parseIntent('probably career')).toBeUndefined();
    expect(parseIntent('{"intent":"car')).toBeUndefined();
    expect(parseIntent('')).toBeUndefined();
  });
});
