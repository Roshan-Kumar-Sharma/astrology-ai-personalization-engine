import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { StructuredLogger } from '../common/logging/logger';
import { RequestTrace } from '../common/logging/request-trace';
import { UpstreamClient } from './upstream.client';
import {
  bundleResults,
  ContextBundle,
  Horoscope,
  Kundli,
  Panchang,
  SourceResult,
  UpstreamName,
  UserProfile,
} from './types';

/**
 * Fans out to every upstream concurrently and returns whatever came back.
 *
 * Two properties matter:
 *   1. Total wall time is max(sources), not sum(sources).
 *   2. One dead service never fails the request. Each source resolves to a
 *      SourceResult carrying its own outcome, so downstream stages can reason
 *      about *what is missing* rather than being handed a half-built object.
 */
@Injectable()
export class ContextAggregator {
  constructor(
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
    private readonly client: UpstreamClient,
    private readonly logger: StructuredLogger,
  ) {}

  async gather(userId: string, trace: RequestTrace): Promise<ContextBundle> {
    const started = performance.now();

    // Each slot is filled the moment its source resolves. `client.fetch` never
    // rejects, so after the deadline we can simply read whatever has landed.
    const slots: Record<UpstreamName, SourceResult<unknown> | undefined> = {
      user: undefined,
      kundli: undefined,
      horoscope: undefined,
      panchang: undefined,
    };

    const track = <T>(name: UpstreamName, p: Promise<SourceResult<T>>) =>
      p.then((r) => {
        slots[name] = r;
        return r;
      });

    const tasks = [
      track(
        'user',
        this.client.fetch<UserProfile>(
          'user',
          this.cfg.UPSTREAM_USER_URL,
          `/users/${userId}`,
          trace,
        ),
      ),
      track(
        'kundli',
        this.client.fetch<Kundli>(
          'kundli',
          this.cfg.UPSTREAM_KUNDLI_URL,
          `/kundli/${userId}`,
          trace,
        ),
      ),
      track(
        'horoscope',
        this.client.fetch<Horoscope>(
          'horoscope',
          this.cfg.UPSTREAM_HOROSCOPE_URL,
          `/horoscope/${userId}`,
          trace,
        ),
      ),
      track(
        'panchang',
        this.client.fetch<Panchang>('panchang', this.cfg.UPSTREAM_PANCHANG_URL, '/panchang', trace),
      ),
    ];

    // A whole-stage deadline on top of the per-source timeouts. Per-source
    // timeouts bound a single call; this bounds the stage even when several
    // sources are slow at once, protecting the end-to-end latency budget.
    const hitDeadline = await Promise.race([
      Promise.all(tasks).then(() => false),
      sleep(this.cfg.CONTEXT_FANOUT_DEADLINE_MS).then(() => true),
    ]);

    if (hitDeadline) {
      trace.note('Fan-out deadline exceeded; proceeding with sources that resolved in time.');
    }

    const bundle: ContextBundle = {
      user: (slots.user ?? abandoned('user')) as SourceResult<UserProfile>,
      kundli: (slots.kundli ?? abandoned('kundli')) as SourceResult<Kundli>,
      horoscope: (slots.horoscope ?? abandoned('horoscope')) as SourceResult<Horoscope>,
      panchang: (slots.panchang ?? abandoned('panchang')) as SourceResult<Panchang>,
    };

    const elapsed = performance.now() - started;
    const results = bundleResults(bundle);

    trace.addSpan('context.fanout', elapsed, {
      outcomes: Object.fromEntries(results.map((r) => [r.source, r.outcome])),
    });

    const degraded = results.filter((r) => r.outcome === 'failed' || r.outcome === 'stale');
    if (degraded.length) {
      trace.note(
        `Degraded sources: ${degraded.map((d) => `${d.source}(${d.outcome})`).join(', ')}`,
      );
    }

    this.logger.info('context.gathered', {
      requestId: trace.requestId,
      userId,
      fanoutMs: Math.round(elapsed),
      // Sum of per-source latencies vs wall time quantifies the concurrency win.
      serialisedMs: Math.round(results.reduce((a, r) => a + r.latencyMs, 0)),
      outcomes: Object.fromEntries(results.map((r) => [r.source, r.outcome])),
      cache: this.client.cacheStats(),
    });

    return bundle;
  }
}

function abandoned(source: UpstreamName): SourceResult<unknown> {
  return {
    source,
    outcome: 'failed',
    error: 'fan-out deadline exceeded',
    latencyMs: 0,
    attempts: 0,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
