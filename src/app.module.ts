import { Module } from '@nestjs/common';
import { CoreModule } from './common/core.module';
import { AstrologyInferenceEngine } from './astrology/inference.service';
import { ConfidenceService } from './answer/confidence.service';
import { GroundednessService } from './answer/groundedness.service';
import { LlmModule } from './llm/llm.module';
import { ContextItemBuilder } from './personalization/context-item.builder';
import { ContextSelector } from './personalization/context.selector';
import { IntentClassifier } from './personalization/intent/intent.classifier';
import { IntentResolver } from './personalization/intent/intent.resolver';
import { PersonalizationService } from './personalization/personalization.service';
import { StyleResolver } from './personalization/style.resolver';
import { GuardrailsService } from './safety/guardrails.service';
import { LlmSafetyScreen } from './safety/llm-safety.screen';
import { ContextAggregator } from './upstream/context-aggregator.service';
import { UpstreamClient } from './upstream/upstream.client';
import { ConsoleController } from './api/console.controller';
import { DebugEnabledGuard } from './api/debug-enabled.guard';
import { DebugController } from './api/debug.controller';
import { PersonalizeController } from './api/personalize.controller';
import { PersonalizeService } from './api/personalize.service';
import { HealthController } from './api/health.controller';

/**
 * Composition root.
 *
 * Flat rather than split into feature modules: at this size a single wiring
 * point is easier to read than six module files, and the architectural
 * boundaries are already enforced by directory structure and by the fact that
 * the domain layer (`astrology/`) has no framework or I/O dependencies at all.
 */
@Module({
  imports: [CoreModule, LlmModule],
  controllers: [PersonalizeController, DebugController, ConsoleController, HealthController],
  providers: [
    // upstream
    UpstreamClient,
    ContextAggregator,

    // domain (pure)
    AstrologyInferenceEngine,

    // personalization engine
    IntentClassifier,
    IntentResolver,
    ContextItemBuilder,
    ContextSelector,
    StyleResolver,
    PersonalizationService,

    // safety
    GuardrailsService,
    LlmSafetyScreen,

    // answer post-processing
    GroundednessService,
    ConfidenceService,

    // orchestration
    PersonalizeService,
    DebugEnabledGuard,
  ],
})
export class AppModule {}
