# 1. Foundations — `src/common/`

These files import nothing from the project. Understand them completely and the
rest of the codebase stops being surprising.

---

## `config/app.config.ts` — validated settings

### The problem it solves

`process.env.PORT` is a `string | undefined`. Every place that uses it must
handle "missing" and "not a number". Miss one and you get `NaN` at 3am.

This file makes settings **validated once, typed forever**.

### The schema

```ts
const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  LLM_PROVIDER: z.enum(['mock', 'anthropic', 'openai', 'openrouter']).default('mock'),
  UPSTREAM_TIMEOUT_MS: z.coerce.number().default(1200),
  // …
});
```

Three things each line does:

- `z.coerce.number()` — env vars are always strings; `"3000"` becomes `3000`.
- `.default(3000)` — absent is fine, and the default is visible in one place.
- `z.enum([...])` — `LLM_PROVIDER=gemini` fails at **boot**, not on first request.

### `loadConfig()`

```ts
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
```

- `safeParse` returns a result instead of throwing, so we can format the error
  ourselves. A raw zod error is unreadable in a container log.
- The `env` parameter **defaults** to `process.env` but can be passed explicitly.
  That is a *test seam*: the e2e suite calls `loadConfig({ ...process.env,
  MOCK_UPSTREAM_PORT: '4099' })` without mutating global state.

### `appConfig()` and the caching trap

```ts
let cached: AppConfig | undefined;

export function appConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}
```

Parse once, reuse forever. **This caching is why `import 'dotenv/config'` must be
the first line of `main.ts`** — if anything calls `appConfig()` before `.env` is
loaded, the defaults get cached permanently and your settings are silently
ignored. That was a real bug in this project.

### `APP_CONFIG`

```ts
export const APP_CONFIG = Symbol('APP_CONFIG');
```

A **dependency-injection token**. NestJS normally injects by class name, but
`AppConfig` is a plain object with no class. A `Symbol` gives it a unique,
collision-proof identity:

```ts
constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}
```

---

## `logging/logger.ts` — structured JSON logs

### Why not `console.log`

`console.log('fetched user in 45ms')` is unsearchable. In production you want
*"show me every request where kundli failed and confidence was LOW"*, which needs
machine-readable fields.

### Levels

```ts
const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

private write(level: LogLevel, event: string, fields: Record<string, unknown>) {
  if (LEVEL_ORDER[level] < this.minLevel) return;   // ← filter
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...redact(fields) });
  this.sink(line);
}
```

Numeric levels make filtering a comparison. With `minLevel = 30 (warn)`,
`debug (10)` and `info (20)` are dropped.

### Reading the level from config

```ts
constructor(@Optional() @Inject(APP_CONFIG) cfg?: AppConfig) {
  if (cfg?.LOG_LEVEL) this.minLevel = LEVEL_ORDER[cfg.LOG_LEVEL];
}
```

`@Optional()` means "inject if available, otherwise `undefined`". That lets the
logger be constructed manually in tests (`new StructuredLogger()`) *and* be
injected by NestJS in the app.

### `sink` — the test seam

```ts
private sink: (line: string) => void = (line) => process.stdout.write(line + '\n');
setSink(sink: (line: string) => void): void { this.sink = sink; }
```

Writing is behind a replaceable function, so a test can capture log lines into an
array and assert on them instead of spying on stdout.

### Redaction — a privacy control

```ts
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
```

**Why this matters here specifically:** the `question` field contains health,
relationship and financial details. Logging it in full would put sensitive
personal data into log aggregation, backups and third-party tooling. We keep
length and a 48-character preview — enough to debug, not enough to be a data
store.

---

## `logging/request-trace.ts` — timings and decisions

One object per request, doing double duty: it feeds the logs *and* the debug
endpoint. That is why the explanation can never drift from the behaviour — they
read the same object.

### `time()` — the `finally` trick

```ts
async time<T>(name: string, fn: () => Promise<T>, meta?): Promise<T> {
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    this.spans.push({ name, ms: round(performance.now() - t0), meta });
  }
}
```

Read the `try/finally` carefully — there is no `catch`.

- On success: `fn()` resolves, the span is recorded, the value is returned.
- On failure: the error propagates **but the span is still recorded**.

So a stage that throws still shows up in the trace with how long it ran before
failing. A naive `const r = await fn(); record();` would lose that.

`timeSync()` is the same shape for non-async work.

### `note()`

```ts
note(message: string): void { this.notes.push(message); }
```

Free-text decisions for humans: *"Intent 'career' (lexicon, confidence 0.98)"*,
*"Degraded sources: horoscope(stale)"*. Surfaced by the debug endpoint.

### `latencyBreakdown()`

```ts
latencyBreakdown(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of this.spans) out[s.name] = (out[s.name] ?? 0) + s.ms;
  return out;
}
```

Collapses spans into `{ "llm.generate": 9880.25, … }` for a single log line.
`(out[s.name] ?? 0) + s.ms` **accumulates** rather than overwrites, so a stage
that runs twice sums correctly.

---

## `cache/ttl-cache.ts` — two-tier expiry

### The idea

A normal cache has one expiry. This one has two:

```ts
interface CacheEntry<T> {
  value: T;
  storedAt: number;
  freshUntil: number;   // after this: stale but still usable
  expiresAt: number;    // after this: gone
}
```

**Why two?** When an upstream service is down, a 40-minute-old horoscope is far
better than an error page. The stale window is a *degradation reserve* — data we
would not serve normally, but will serve rather than fail.

### `set()`

```ts
set(key: string, value: T, freshMs: number, staleMs = 0): void {
  if (this.store.size >= this.maxEntries) this.evictOldest();
  const t = this.now();
  this.store.set(key, {
    value,
    storedAt: t,
    freshUntil: t + freshMs,
    expiresAt: t + freshMs + staleMs,   // ← stale window is ADDITIONAL
  });
}
```

Note `this.now()` rather than `Date.now()`:

```ts
constructor(private readonly maxEntries = 5_000, private readonly now: () => number = () => Date.now()) {}
```

The clock is **injected**. Tests advance a variable instead of sleeping, so cache
expiry tests run in microseconds:

```ts
let now = 1_000_000;
const cache = new TtlCache<string>(100, () => now);
cache.set('k', 'v', 1000);
now += 1500;                    // "1.5 seconds later"
expect(cache.get('k')).toBeUndefined();
```

### `getAllowStale()` — the real lookup

```ts
getAllowStale(key: string): CacheGetResult<T> | undefined {
  const entry = this.store.get(key);
  const t = this.now();
  if (!entry) { this.misses += 1; return undefined; }
  if (t > entry.expiresAt) {            // fully dead
    this.store.delete(key);             // evict on read — no background timer
    this.misses += 1;
    return undefined;
  }
  this.hits += 1;
  return { value: entry.value, stale: t > entry.freshUntil, ageMs: t - entry.storedAt };
}
```

The caller receives `stale: true/false` and **decides what to do**. The cache does
not decide policy; it reports state. `UpstreamClient` uses `get()` on the happy
path and `getAllowStale()` only when a fetch has failed.

### `evictOldest()`

```ts
private evictOldest(): void {
  const oldest = this.store.keys().next();   // Map preserves insertion order
  if (!oldest.done) this.store.delete(oldest.value);
}
```

A JavaScript `Map` iterates in insertion order, so the first key is the oldest
*write*. This is FIFO, not LRU — simpler, and adequate because entries expire on
time anyway.

---

## `resilience/retry.ts`

### `withTimeout()`

```ts
export async function withTimeout<T>(ms: number, label: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();                     // ① actually cancel the work
      reject(new TimeoutError(ms, label));    // ② reject the race
    }, ms);
  });
  try {
    return await Promise.race([fn(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);           // ③ always clean up
  }
}
```

Three details worth understanding:

**① `controller.abort()` matters.** `Promise.race` alone would *ignore* the slow
promise but the HTTP request would keep running, holding a socket. Passing the
`signal` into `fetch` means the request is genuinely cancelled.

**② `Promise<never>`** — a promise that can only reject. The type says "this branch
never produces a value".

**③ `clearTimeout` in `finally`** — if `fn()` finishes in 5ms, an uncancelled
1200ms timer would keep the Node event loop alive. This is a classic hanging-test
cause.

### `retry()` — and why full jitter

```ts
for (let attempt = 1; attempt <= attempts; attempt++) {
  try {
    return await fn(attempt);
  } catch (err) {
    lastErr = err;
    const isLast = attempt === attempts;
    if (isLast || !isRetryable(err)) break;
    const ceiling = baseDelayMs * 2 ** (attempt - 1);
    const delay = Math.round(random() * ceiling);   // ← full jitter
    onRetry?.(err, attempt, delay);
    await sleep(delay);
  }
}
throw lastErr;
```

`ceiling` doubles each attempt: 60ms, 120ms, 240ms — standard exponential backoff.

Then `random() * ceiling` picks a value **anywhere in `[0, ceiling]`**. This is
"full jitter", not "backoff plus a bit of noise".

**Why it matters here specifically:** every request fans out to four services
simultaneously. Without jitter, a blip makes every caller retry at exactly
60ms, then exactly 120ms — synchronised waves that re-hammer a service trying to
recover. Full jitter spreads them evenly.

`isRetryable` prevents pointless work:

```ts
isRetryable: (err) => !(err instanceof HttpStatusError && err.status < 500)
```

A 404 will be a 404 next time. Only 5xx, timeouts and transport errors retry.

`sleep` and `random` are injectable parameters — tests pass deterministic
versions instead of waiting.

---

## `resilience/circuit-breaker.ts`

### The counter-intuitive purpose

A circuit breaker usually protects the *downstream* service from load. Here it
mostly protects **our own latency budget**.

If the Panchang service is hard-down, every request would otherwise burn
`2 attempts × 1200ms timeout` before degrading. Opening the circuit fails that
source **instantly**, leaving the time budget for the LLM call. Astrology answers
degrade gracefully; slow answers do not.

### Three states

```ts
shouldTrip(): boolean {
  if (this.state === 'open') {
    if (this.now() - this.openedAt >= this.cooldownMs) {
      this.state = 'half-open';
      return false;          // let ONE probe request through
    }
    return true;             // still open — skip the call
  }
  return false;
}
```

- **closed** — normal, calls go through.
- **open** — failing fast, no calls.
- **half-open** — cooldown elapsed; allow one probe to test recovery.

```ts
recordFailure(): void {
  this.failures += 1;
  if (this.state === 'half-open' || this.failures >= this.failureThreshold) {
    this.state = 'open';
    this.openedAt = this.now();
  }
}
```

Note `this.state === 'half-open' ||` — a failed probe re-opens **immediately**,
without waiting for another five failures. One failure in half-open is enough
evidence that the service is still down.

```ts
recordSuccess(): void {
  this.failures = 0;
  this.state = 'closed';
}
```

Any success fully resets. Simple, and adequate at this scale.

---

## `logging/request-logging.middleware.ts`

```ts
export function requestLogging(logger: StructuredLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('http.request', { requestId, method: req.method, path: req.path,
                                    status: res.statusCode, durationMs: round(ms) });
    });
    next();
  };
}
```

- **Reuses an inbound `x-request-id`** if present, so a trace survives across
  services; generates one otherwise.
- **Echoes it on the response**, so a user reporting a problem can quote an id
  that appears in every log line for that request.
- **`res.on('finish')`** fires when the response has been sent — the only place
  the real duration and status are known.
- **`process.hrtime.bigint()`** is a monotonic nanosecond clock. Unlike
  `Date.now()`, it cannot jump backwards if the system clock is adjusted.

---

## `core.module.ts`

```ts
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: appConfig }, StructuredLogger],
  exports: [APP_CONFIG, StructuredLogger],
})
export class CoreModule {}
```

`@Global()` means any module can inject these without importing `CoreModule`.
Used sparingly — config and logging are needed by every layer, and threading them
through each module's `imports` would add noise without adding a real boundary.

This file exists because of a real bug: `LlmModule` needed `APP_CONFIG`, which
was declared in `AppModule` and therefore invisible to it. Nest failed at boot
with *"can't resolve dependencies of Symbol(LLM_PROVIDER)"*.
