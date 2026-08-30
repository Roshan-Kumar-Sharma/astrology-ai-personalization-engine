export class TimeoutError extends Error {
  constructor(
    public readonly ms: number,
    label = 'operation',
  ) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Races a promise against a deadline, aborting via the supplied AbortController. */
export async function withTimeout<T>(
  ms: number,
  label: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(ms, label));
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  /** Only retry when this returns true. Never retry a 4xx: it will fail again. */
  isRetryable?: (err: unknown) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Retry with exponential backoff and full jitter.
 *
 * Full jitter (delay = random(0, base * 2^n)) rather than fixed backoff, because
 * every request in this service fans out to four upstreams at once. Without
 * jitter a blip causes all callers to retry in lockstep and stampede the
 * recovering service.
 */
export async function retry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: RetryOptions,
): Promise<T> {
  const {
    attempts,
    baseDelayMs,
    isRetryable = () => true,
    onRetry,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = opts;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      const isLast = attempt === attempts;
      if (isLast || !isRetryable(err)) break;
      const ceiling = baseDelayMs * 2 ** (attempt - 1);
      const delay = Math.round(random() * ceiling);
      onRetry?.(err, attempt, delay);
      await sleep(delay);
    }
  }
  throw lastErr;
}
