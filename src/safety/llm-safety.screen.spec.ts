import { AppConfig, loadConfig } from '../common/config/app.config';
import { StructuredLogger } from '../common/logging/logger';
import { RequestTrace } from '../common/logging/request-trace';
import { LlmProvider, LlmRequest, LlmResponse } from '../llm/llm.provider';
import { LlmSafetyScreen, parsePolicyId } from './llm-safety.screen';

class FakeProvider implements LlmProvider {
  readonly name = 'fake';
  readonly model = 'fake-1';
  calls = 0;
  lastRequest?: LlmRequest;
  constructor(private readonly behaviour: () => string | Promise<string>) {}
  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.calls++;
    this.lastRequest = req;
    return { text: await this.behaviour(), model: this.model, provider: this.name, latencyMs: 1 };
  }
}

const logger = new StructuredLogger();
logger.setLevel('error');

const cfg = (over: Record<string, string> = {}): AppConfig =>
  loadConfig({ LLM_PROVIDER: 'mock', LOG_LEVEL: 'error', ...over } as never);

const screen = (
  p: FakeProvider,
  over: Record<string, string> = {},
  q = 'Will I outlive my husband?',
) =>
  new LlmSafetyScreen(cfg({ SAFETY_LLM_SCREEN: 'true', ...over }), p, logger).screen(
    q,
    new RequestTrace('t'),
  );

describe('LlmSafetyScreen', () => {
  it('makes no call when it is switched off', async () => {
    const p = new FakeProvider(() => '{"policy":"death_timing"}');
    const r = await new LlmSafetyScreen(cfg(), p, logger).screen('anything', new RequestTrace('t'));
    expect(p.calls).toBe(0);
    expect(r.outcome).toBe('off');
  });

  it('refuses under the policy the model names', async () => {
    const p = new FakeProvider(() => '{"policy":"death_timing"}');
    const r = await screen(p);
    expect(r.outcome).toBe('flagged');
    expect(r.policy?.id).toBe('death_timing');
  });

  /**
   * The user must never read model-generated refusal copy. The second layer
   * picks a policy; the policy already owns what gets said, and that text has
   * been reviewed.
   */
  it('returns the policy so its reviewed response is what the user reads', async () => {
    const p = new FakeProvider(() => '{"policy":"crisis_self_harm"}');
    const r = await screen(p);
    expect(r.policy?.blockResponse).toContain('14416');
    expect(r.policy?.blockResponse).not.toContain('{"policy"');
  });

  it('lets an ordinary question through', async () => {
    const p = new FakeProvider(() => '{"policy":"none"}');
    expect((await screen(p, {}, 'Will my career die out in this industry?')).outcome).toBe('clear');
  });

  /**
   * Every one of these is the fail-open direction. This layer is additive: when
   * it cannot answer, the service must behave exactly as it does with the layer
   * switched off, never worse and never more restrictive.
   */
  it.each([
    ['an invented category', () => '{"policy":"bad_vibes"}'],
    ['a constrain-only policy it may not use', () => '{"policy":"legal_outcome"}'],
    ['prose instead of JSON', () => 'This looks like a death question to me'],
    ['a truncated reply', () => '{"policy":"death_tim'],
    ['an empty reply', () => ''],
  ])('lets the question through on %s', async (_label, behaviour) => {
    expect((await screen(new FakeProvider(behaviour))).policy).toBeUndefined();
  });

  it('lets the question through when the model throws', async () => {
    const p = new FakeProvider(() => {
      throw new Error('503');
    });
    const r = await screen(p);
    expect(r.outcome).toBe('unavailable');
    expect(r.policy).toBeUndefined();
  });

  it('lets the question through when the model times out', async () => {
    const p = new FakeProvider(
      () => new Promise((res) => setTimeout(() => res('{"policy":"death_timing"}'), 200)),
    );
    const r = await screen(p, { SAFETY_LLM_TIMEOUT_MS: '20' });
    expect(r.outcome).toBe('unavailable');
    expect(r.policy).toBeUndefined();
  });

  it('gives the model the blocking policies and the negative examples', async () => {
    const p = new FakeProvider(() => '{"policy":"none"}');
    await screen(p);
    const sys = p.lastRequest!.systemStatic;
    expect(sys).toContain('death_timing');
    expect(sys).toContain('prenatal_sex_determination');
    // Constrain-action policies are not this layer's business.
    expect(sys).not.toContain('legal_outcome');
    // The precision half: without counter-examples the model drifts to "yes".
    expect(sys).toContain('die out in this industry');
  });
});

describe('parsePolicyId', () => {
  it('accepts a blocking policy id', () => {
    expect(parsePolicyId('{"policy":"medical_prognosis"}')).toBe('medical_prognosis');
  });
  it('strips visible chain-of-thought', () => {
    expect(parsePolicyId('<think>hmm</think>{"policy":"harm_to_others"}')).toBe('harm_to_others');
  });
  it('tolerates fences and casing', () => {
    expect(parsePolicyId('```json\n{"policy":" Death_Timing "}\n```')).toBe('death_timing');
  });
  it('reads none, invented ids and junk as no refusal', () => {
    expect(parsePolicyId('{"policy":"none"}')).toBeUndefined();
    expect(parsePolicyId('{"policy":"made_up"}')).toBeUndefined();
    expect(parsePolicyId('{"policy":"legal_outcome"}')).toBeUndefined();
    expect(parsePolicyId('nonsense')).toBeUndefined();
  });
});
