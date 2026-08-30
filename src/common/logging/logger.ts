import { Inject, Injectable, Optional, Scope } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/app.config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured JSON logger.
 *
 * Every line is a single JSON object so logs are queryable in any aggregator
 * (CloudWatch Insights / Loki / Datadog) without regex parsing. `requestId` is
 * threaded through every log line for a request so a single trace can be
 * reconstructed from the full stage pipeline.
 */
@Injectable({ scope: Scope.DEFAULT })
export class StructuredLogger {
  private minLevel: number = LEVEL_ORDER.info;
  private sink: (line: string) => void = (line) => process.stdout.write(line + '\n');

  /**
   * Reads the level from configuration at construction so every entrypoint -
   * the server, tests, scripts - behaves identically without having to
   * remember to call setLevel.
   */
  constructor(@Optional() @Inject(APP_CONFIG) cfg?: AppConfig) {
    if (cfg?.LOG_LEVEL) this.minLevel = LEVEL_ORDER[cfg.LOG_LEVEL];
  }

  setLevel(level: LogLevel): void {
    this.minLevel = LEVEL_ORDER[level];
  }

  /** Test seam: capture log lines instead of writing to stdout. */
  setSink(sink: (line: string) => void): void {
    this.sink = sink;
  }

  debug(event: string, fields: Record<string, unknown> = {}) {
    this.write('debug', event, fields);
  }
  info(event: string, fields: Record<string, unknown> = {}) {
    this.write('info', event, fields);
  }
  warn(event: string, fields: Record<string, unknown> = {}) {
    this.write('warn', event, fields);
  }
  error(event: string, fields: Record<string, unknown> = {}) {
    this.write('error', event, fields);
  }

  private write(level: LogLevel, event: string, fields: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < this.minLevel) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...redact(fields),
    });
    this.sink(line);
  }
}

/**
 * The question a user asks is personal data (health, relationships, finances).
 * We log its shape, never its full content, unless explicitly at debug level.
 */
const SENSITIVE_KEYS = new Set(['question', 'answer', 'prompt', 'apiKey', 'name']);

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (SENSITIVE_KEYS.has(k) && typeof v === 'string') {
      out[`${k}Chars`] = v.length;
      out[`${k}Preview`] = v.slice(0, 48);
    } else {
      out[k] = v;
    }
  }
  return out;
}
