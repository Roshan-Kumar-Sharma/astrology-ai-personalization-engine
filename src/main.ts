// Must be first: populates process.env from .env before anything reads config.
// `appConfig()` validates and caches on first call, so a later load would be
// silently ignored and the service would boot with defaults.
import 'dotenv/config';
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { appConfig } from './common/config/app.config';
import { StructuredLogger } from './common/logging/logger';
import { requestLogging } from './common/logging/request-logging.middleware';
import { startMockUpstream } from './upstream/mock/mock-upstream.server';

async function bootstrap() {
  const cfg = appConfig();

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const logger = app.get(StructuredLogger);
  logger.setLevel(cfg.LOG_LEVEL);

  app.use(requestLogging(logger));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  app.enableShutdownHooks();

  // The mock upstream runs in-process on its own port so a single `npm start`
  // gives a working system. Point UPSTREAM_*_URL at real services and set
  // MOCK_UPSTREAM_ENABLED=false to take it out of the picture.
  if (cfg.MOCK_UPSTREAM_ENABLED) {
    const server = await startMockUpstream(cfg, logger);
    process.on('SIGTERM', () => server.close());
    process.on('SIGINT', () => server.close());
  }

  await app.listen(cfg.PORT);
  logger.info('server.started', {
    port: cfg.PORT,
    env: cfg.NODE_ENV,
    llmProvider: cfg.LLM_PROVIDER,
    mockUpstream: cfg.MOCK_UPSTREAM_ENABLED ? cfg.MOCK_UPSTREAM_PORT : 'disabled',
  });
}

bootstrap().catch((err) => {
  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'error',
      event: 'server.boot_failed',
      reason: err instanceof Error ? err.message : String(err),
    }) + '\n',
  );
  process.exit(1);
});
