import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { StructuredLogger } from '../common/logging/logger';
import { LLM_PROVIDER, LlmProvider } from './llm.provider';
import { AnthropicLlmProvider } from './providers/anthropic.provider';
import { MockLlmProvider } from './providers/mock.provider';
import { OpenAiLlmProvider } from './providers/openai.provider';
import { PromptBuilder } from './prompt/prompt.builder';

/**
 * Provider selection happens exactly once, here.
 *
 * Nothing downstream knows which provider is active - the pipeline depends on
 * the `LlmProvider` interface only. Adding Gemini or a self-hosted model is a
 * new class plus one case in this factory.
 *
 * Selection degrades rather than crashes: asking for a provider whose key is
 * missing falls back to the mock with a warning, so a missing environment
 * variable produces a working service rather than a boot failure.
 */
@Global()
@Module({
  providers: [
    PromptBuilder,
    MockLlmProvider,
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG, StructuredLogger],
      useFactory: (cfg: AppConfig, logger: StructuredLogger): LlmProvider => {
        switch (cfg.LLM_PROVIDER) {
          case 'anthropic': {
            if (!cfg.ANTHROPIC_API_KEY) {
              logger.warn('llm.provider_fallback', {
                requested: 'anthropic',
                reason: 'ANTHROPIC_API_KEY is not set',
              });
              return new MockLlmProvider();
            }
            logger.info('llm.provider_selected', {
              provider: 'anthropic',
              model: cfg.ANTHROPIC_MODEL,
            });
            return new AnthropicLlmProvider({
              apiKey: cfg.ANTHROPIC_API_KEY,
              model: cfg.ANTHROPIC_MODEL,
              timeoutMs: cfg.LLM_TIMEOUT_MS,
            });
          }
          case 'openai': {
            if (!cfg.OPENAI_API_KEY) {
              logger.warn('llm.provider_fallback', {
                requested: 'openai',
                reason: 'OPENAI_API_KEY is not set',
              });
              return new MockLlmProvider();
            }
            logger.info('llm.provider_selected', { provider: 'openai', model: cfg.OPENAI_MODEL });
            return new OpenAiLlmProvider({
              apiKey: cfg.OPENAI_API_KEY,
              model: cfg.OPENAI_MODEL,
              baseUrl: cfg.OPENAI_BASE_URL,
              timeoutMs: cfg.LLM_TIMEOUT_MS,
            });
          }
          /**
           * OpenRouter needs no adapter of its own: its API is
           * OpenAI-compatible, so it is the same class with a different base
           * URL and two attribution headers. That is the provider abstraction
           * paying for itself - a whole new vendor for nine lines.
           */
          case 'openrouter': {
            if (!cfg.OPENROUTER_API_KEY) {
              logger.warn('llm.provider_fallback', {
                requested: 'openrouter',
                reason: 'OPENROUTER_API_KEY is not set',
              });
              return new MockLlmProvider();
            }
            logger.info('llm.provider_selected', {
              provider: 'openrouter',
              model: cfg.OPENROUTER_MODEL,
            });
            return new OpenAiLlmProvider({
              apiKey: cfg.OPENROUTER_API_KEY,
              model: cfg.OPENROUTER_MODEL,
              baseUrl: cfg.OPENROUTER_BASE_URL,
              timeoutMs: cfg.LLM_TIMEOUT_MS,
              label: 'openrouter',
              extraHeaders: {
                'HTTP-Referer': cfg.OPENROUTER_APP_URL,
                'X-Title': cfg.OPENROUTER_APP_NAME,
              },
            });
          }
          default:
            logger.info('llm.provider_selected', { provider: 'mock' });
            return new MockLlmProvider();
        }
      },
    },
  ],
  exports: [LLM_PROVIDER, PromptBuilder, MockLlmProvider],
})
export class LlmModule {}
