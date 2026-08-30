import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, appConfig } from './config/app.config';
import { StructuredLogger } from './logging/logger';

/**
 * Cross-cutting singletons: validated configuration and the structured logger.
 *
 * Global because every layer needs them and threading them through each feature
 * module's imports would add noise without adding any real boundary. These are
 * the only two things treated this way.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: appConfig }, StructuredLogger],
  exports: [APP_CONFIG, StructuredLogger],
})
export class CoreModule {}
