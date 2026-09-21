import { Test } from '@nestjs/testing';
import { AppModule } from '../app.module';
import { APP_CONFIG, loadConfig } from '../common/config/app.config';
import { RequestTrace } from '../common/logging/request-trace';
import { StructuredLogger } from '../common/logging/logger';
import { LLM_PROVIDER, LlmProvider, LlmRequest, LlmResponse } from '../llm/llm.provider';
import { PersonalizeService } from '../api/personalize.service';

class CountingProvider implements LlmProvider {
  readonly name = 'counting';
  readonly model = 'counting-1';
  calls: LlmRequest[] = [];
  async generate(req: LlmRequest): Promise<LlmResponse> {
    this.calls.push(req);
    return {
      text: '{"policy":"death_timing"}',
      model: this.model,
      provider: this.name,
      latencyMs: 1,
    };
  }
}

/**
 * The layering invariant, asserted at the pipeline rather than the unit.
 *
 * The second safety layer may only ever *add* a refusal. A question the
 * deterministic layer has already refused must not be sent anywhere - not to
 * the upstreams, not to the screen, not to the generator. That is what makes
 * the layer safe to add: no phrasing can talk the system out of a refusal it
 * has already decided on, because by then nothing is left to talk to.
 */
describe('safety layering', () => {
  const ENV = {
    LLM_PROVIDER: 'mock',
    LOG_LEVEL: 'error',
    MOCK_UPSTREAM_ENABLED: 'false',
    SAFETY_LLM_SCREEN: 'true',
  };

  let service: PersonalizeService;
  let provider: CountingProvider;

  beforeAll(async () => {
    provider = new CountingProvider();
    const logger = new StructuredLogger();
    logger.setLevel('error');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(loadConfig(ENV as never))
      .overrideProvider(LLM_PROVIDER)
      .useValue(provider)
      .overrideProvider(StructuredLogger)
      .useValue(logger)
      .compile();
    service = moduleRef.get(PersonalizeService);
  });

  it('never reaches the model when the deterministic layer refuses', async () => {
    const res = await service.personalize({
      userId: 'user_101',
      question: 'When will I die?',
      trace: new RequestTrace('t'),
      verbose: true,
    });

    expect(res.meta?.blocked).toBe(true);
    expect(res.meta?.policies).toEqual(['death_timing']);
    expect(res.answer).toContain('no responsible astrologer');
    // The whole point: the screen is enabled, and still nothing was sent.
    expect(provider.calls).toHaveLength(0);
  });
});
