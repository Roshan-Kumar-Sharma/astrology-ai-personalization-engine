import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { TtlCache } from '../common/cache/ttl-cache';
import { CircuitBreaker } from '../common/resilience/circuit-breaker';
import { retry, withTimeout } from '../common/resilience/retry';
import { StructuredLogger } from '../common/logging/logger';
import { RequestTrace } from '../common/logging/request-trace';
import { cacheTtlFor } from './cache-policy';
import { SourceResult, UpstreamName } from './types';

class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpStatusError';
  }
}

/**
 * Single generic HTTP client used for all five upstreams.
 *
 * Retry / timeout / caching / circuit-breaking are cross-cutting concerns, so
 * they live here once rather than being reimplemented per service. Adding a
 * fifth upstream (transits, compatibility, remedies) means adding a URL and a
 * type - no new resilience code.
 */
@Injectable()
export class UpstreamClient {
  private readonly cache = new TtlCache<unknown>();
  private readonly breakers = new Map<UpstreamName, CircuitBreaker>();

  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly logger: StructuredLogger,
  ) {}

  cacheStats() {
    return this.cache.stats();
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Fetch one upstream with the full resilience stack.
   *
   * Never throws: a failed source is a *result*, not an exception. The engine's
   * job is to answer with whatever context it managed to gather, so partial
   * failure has to be a first-class value that flows into confidence scoring.
   */
  async fetch<T>(
    source: UpstreamName,
    baseUrl: string,
    path: string,
    trace: RequestTrace,
  ): Promise<SourceResult<T>> {
    const started = performance.now();
    const cacheKey = `${source}:${path}`;
    const ttl = cacheTtlFor(source);

    const fresh = this.cache.get(cacheKey);
    if (fresh) {
      return {
        source,
        outcome: 'cached',
        data: fresh.value as T,
        latencyMs: round(performance.now() - started),
        ageMs: fresh.ageMs,
        attempts: 0,
      };
    }

    const breaker = this.breakerFor(source);
    if (breaker.shouldTrip()) {
      trace.note(`${source}: circuit open, skipped upstream call`);
      return this.staleOrFail(source, cacheKey, started, 'circuit open', 0);
    }

    let attempts = 0;
    try {
      const data = await retry<T>(
        async (attempt) => {
          attempts = attempt;
          return withTimeout(this.cfg.UPSTREAM_TIMEOUT_MS, `${source} fetch`, async (signal) => {
            const res = await fetch(`${baseUrl}${path}`, {
              signal,
              headers: { 'x-request-id': trace.requestId, accept: 'application/json' },
            });
            if (!res.ok) throw new HttpStatusError(res.status, `${source} returned ${res.status}`);
            return (await res.json()) as T;
          });
        },
        {
          attempts: this.cfg.UPSTREAM_RETRY_ATTEMPTS,
          baseDelayMs: this.cfg.UPSTREAM_RETRY_BASE_DELAY_MS,
          // A 404 or 400 will fail identically on retry; only retry 5xx,
          // timeouts and transport errors.
          isRetryable: (err) => !(err instanceof HttpStatusError && err.status < 500),
          onRetry: (err, attempt, delayMs) =>
            this.logger.warn('upstream.retry', {
              requestId: trace.requestId,
              source,
              attempt,
              delayMs,
              reason: errMessage(err),
            }),
        },
      );

      breaker.recordSuccess();
      this.cache.set(cacheKey, data, ttl.freshMs, ttl.staleMs);
      return {
        source,
        outcome: 'ok',
        data,
        latencyMs: round(performance.now() - started),
        attempts,
      };
    } catch (err) {
      breaker.recordFailure();
      this.logger.warn('upstream.failed', {
        requestId: trace.requestId,
        source,
        attempts,
        reason: errMessage(err),
        circuit: breaker.getState(),
      });
      return this.staleOrFail(source, cacheKey, started, errMessage(err), attempts);
    }
  }

  /**
   * Stale-while-revalidate fallback: a 40-minute-old horoscope beats an error.
   * The staleness is recorded and later reduces the response's confidence.
   */
  private staleOrFail<T>(
    source: UpstreamName,
    cacheKey: string,
    started: number,
    error: string,
    attempts: number,
  ): SourceResult<T> {
    const stale = this.cache.getAllowStale(cacheKey);
    if (stale) {
      return {
        source,
        outcome: 'stale',
        data: stale.value as T,
        error,
        latencyMs: round(performance.now() - started),
        ageMs: stale.ageMs,
        attempts,
      };
    }
    return {
      source,
      outcome: 'failed',
      error,
      latencyMs: round(performance.now() - started),
      attempts,
    };
  }

  private breakerFor(source: UpstreamName): CircuitBreaker {
    let b = this.breakers.get(source);
    if (!b) {
      b = new CircuitBreaker();
      this.breakers.set(source, b);
    }
    return b;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
