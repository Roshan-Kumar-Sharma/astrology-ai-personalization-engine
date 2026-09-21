import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from '../common/config/app.config';
import { StructuredLogger } from '../common/logging/logger';
import { LLM_PROVIDER } from './llm.provider';
import { createLlmProvider } from './provider.factory';
import { MockLlmProvider } from './providers/mock.provider';
import { PromptBuilder } from './prompt/prompt.builder';

/**
 * Nothing downstream knows which provider is active - the pipeline depends on
 * the `LlmProvider` interface only. Adding Gemini or a self-hosted model is a
 * new class plus one case in `createLlmProvider`.
 */
@Global()
@Module({
  providers: [
    PromptBuilder,
    MockLlmProvider,
    {
      provide: LLM_PROVIDER,
      inject: [APP_CONFIG, StructuredLogger],
      useFactory: createLlmProvider,
    },
  ],
  exports: [LLM_PROVIDER, PromptBuilder, MockLlmProvider],
})
export class LlmModule {}
