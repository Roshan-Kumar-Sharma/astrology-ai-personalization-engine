import { randomUUID } from 'node:crypto';

export interface Span {
  name: string;
  ms: number;
  meta?: Record<string, unknown>;
}

/**
 * A per-request accumulator for timings and engine decisions.
 *
 * One object powers two very different needs:
 *   1. Observability  -> emitted as a structured log line at the end of a request.
 *   2. Explainability -> surfaced by POST /debug/personalization so a human can
 *                        see *why* the engine chose what it chose.
 *
 * Keeping these unified means the explanation we show is literally the same data
 * we operate on, so the debug view can never drift from real behaviour.
 */
export class RequestTrace {
  readonly requestId: string;
  readonly startedAt: number;
  private readonly spans: Span[] = [];
  private readonly notes: string[] = [];

  constructor(requestId?: string) {
    this.requestId = requestId ?? randomUUID();
    this.startedAt = Date.now();
  }

  /** Time an async stage and record it as a span. */
  async time<T>(name: string, fn: () => Promise<T>, meta?: Record<string, unknown>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.spans.push({ name, ms: round(performance.now() - t0), meta });
    }
  }

  /** Time a synchronous stage. */
  timeSync<T>(name: string, fn: () => T, meta?: Record<string, unknown>): T {
    const t0 = performance.now();
    try {
      return fn();
    } finally {
      this.spans.push({ name, ms: round(performance.now() - t0), meta });
    }
  }

  addSpan(name: string, ms: number, meta?: Record<string, unknown>): void {
    this.spans.push({ name, ms: round(ms), meta });
  }

  /** Human-readable decisions worth surfacing in the debug endpoint. */
  note(message: string): void {
    this.notes.push(message);
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  getNotes(): string[] {
    return [...this.notes];
  }

  totalMs(): number {
    return Date.now() - this.startedAt;
  }

  /** Compact { stage: ms } map for log lines. */
  latencyBreakdown(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.spans) out[s.name] = (out[s.name] ?? 0) + s.ms;
    return out;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
