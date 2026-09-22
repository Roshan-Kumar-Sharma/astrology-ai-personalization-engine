# 2. Upstream — `src/upstream/`

Everything about talking to the five backend services — the four in the brief plus the transit service. Read `types.ts` first —
it defines the vocabulary the rest of the codebase uses.

---

## `types.ts`

### The service shapes

`UserProfile`, `Kundli`, `Horoscope`, `Panchang` mirror the brief's payloads.
Two additions worth noting:

```ts
birthDetails: {
  date: string;
  time?: string;                                   // ← optional
  place: string;
  timeAccuracy?: 'exact' | 'approximate' | 'unknown';   // ← optional, added by us
};
```

`time` is optional because **birth time genuinely is often unknown** — a very
common real-world case in India. `timeAccuracy` lets an upstream tell us how much
to trust it; when absent we infer it heuristically.

### `SourceResult<T>` — the most important type in the folder

```ts
export interface SourceResult<T> {
  source: UpstreamName;
  outcome: 'ok' | 'cached' | 'stale' | 'failed' | 'skipped';
  data?: T;
  error?: string;
  latencyMs: number;
  ageMs?: number;
  attempts: number;
}
```

**Read this as a design statement.** A failed fetch is not an exception — it is a
*result with an outcome*. `data` is optional, so TypeScript forces every caller to
handle absence:

```ts
const k = bundle.kundli.data;
if (!k) return [];        // the compiler makes you write this
```

The five outcomes carry distinct meaning:

| Outcome | Means | Confidence impact |
|---|---|---|
| `ok` | Fresh from the service | full |
| `cached` | Fresh from cache | full — identical data |
| `stale` | Expired but served anyway | 0.6× — degraded |
| `failed` | Nothing available | 0 |
| `skipped` | Circuit open, not attempted | 0 |

### `ContextBundle` and `bundleResults`

```ts
export interface ContextBundle {
  user: SourceResult<UserProfile>;
  kundli: SourceResult<Kundli>;
  horoscope: SourceResult<Horoscope>;
  panchang: SourceResult<Panchang>;
}

export function bundleResults(b: ContextBundle): SourceResult<unknown>[] {
  return [b.user, b.kundli, b.horoscope, b.panchang];
}
```

The bundle is a **named struct**, so `bundle.kundli.data` is typed as `Kundli`.
`bundleResults()` exists because some code wants to iterate uniformly ("how many
sources failed?"). Doing that with `Object.values()` loses the types, so the
helper does it once, explicitly.

---

## `cache-policy.ts` — TTLs derived from meaning

This file is small and is one of the best things to point at in an interview.

### `msUntilIstHour()`

```ts
const IST_OFFSET_MIN = 330;   // UTC+5:30

export function msUntilIstHour(hourIst: number, now = new Date()): number {
  const istNow = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const target = new Date(istNow);
  target.setUTCHours(hourIst, 0, 0, 0);
  if (target <= istNow) target.setUTCDate(target.getUTCDate() + 1);
  return target.getTime() - istNow.getTime();
}
```

Line by line:

1. Shift "now" forward by 5h30m, giving a `Date` whose **UTC fields read as IST**.
   That is why every call afterwards uses `setUTCHours`/`getUTCDate` — we are
   deliberately treating UTC accessors as IST values.
2. Copy it, and set the clock to `hourIst:00:00.000`.
3. If that moment has already passed today, move to tomorrow.
4. Return the difference in milliseconds.

No date library — about ten lines of arithmetic. Worth knowing why: adding
`date-fns` or `moment` for one function would be a dependency for ergonomics we
do not need.

### `cacheTtlFor()`

```ts
export function cacheTtlFor(source: UpstreamName, now = new Date()): CacheTtl {
  switch (source) {
    case 'kundli':    return { freshMs: 6 * 60 * 60_000, staleMs: 24 * 60 * 60_000 };
    case 'horoscope': return { freshMs: msUntilIstHour(0, now), staleMs: 12 * 60 * 60_000 };
    case 'panchang':  return { freshMs: msUntilIstHour(6, now), staleMs: 12 * 60 * 60_000 };
    case 'user':      return { freshMs: 60_000, staleMs: 10 * 60_000 };
    case 'transit':   return { freshMs: msUntilIstHour(0, now), staleMs: 7 * 24 * 60 * 60_000 };
  }
}
```

Each number comes from what the data **is**:

- **kundli 6h** — the birth chart is immutable, but the *dasha pointer* moves.
  Sub-periods last months, so six hours guarantees a transition is seen the same
  day. (A tempting mistake is "cache forever" — the chart is fixed, but the
  reading of *where you are in it* is not.)
- **horoscope until IST midnight** — generated per calendar day.
- **panchang until 06:00 IST** — the panchang day runs **sunrise to sunrise**, not
  midnight to midnight. This is a genuine domain detail, not an arbitrary choice.
- **user 60s** — mutable at any moment; someone switching to Hindi expects the
  next answer in Hindi.
- **transit until IST midnight, stale for a week** — the slow movers barely
  move: Saturn ~0.03° a day, Jupiter ~0.08°, the nodes ~0.05°. A position a
  week old is wrong by well under a degree, and only a sign ingress inside that
  week could change a conclusion.

Note the switch has no `default`. With a typed union, TypeScript verifies every
case is handled — and that is not hypothetical: adding the transit service on
2026-09-22 failed to compile at exactly this switch until the case was written.

### `SOURCE_CRITICALITY`

```ts
export const SOURCE_CRITICALITY: Record<UpstreamName, number> = {
  user: 0.15, kundli: 0.4, horoscope: 0.25, panchang: 0.1, transit: 0.1,
};
```

Sums to 1.0. Used by the confidence calculator: losing the kundli costs 0.40 of
the completeness factor; losing the panchang or the transits costs 0.10 each.
Losing the user profile is survivable because every style axis has a default.
When the transit service was added, kundli and horoscope each gave up a little
to make room — transits colour an answer rather than carry it, so losing them
costs about what losing the panchang does.

---

## `upstream.client.ts` — one client, all resilience

### Why one generic client

Retry, timeout, caching and circuit-breaking are **cross-cutting**. Four separate
clients would mean four copies. Here they exist once, so adding a fifth service
inherits all of it.

### `fetch()` — walking the whole method

```ts
async fetch<T>(source, baseUrl, path, trace): Promise<SourceResult<T>> {
  const started = performance.now();
  const cacheKey = `${source}:${path}`;
  const ttl = cacheTtlFor(source);
```

`cacheKey` includes the path, so `kundli:/kundli/user_101` and
`kundli:/kundli/user_102` are separate entries.

```ts
  const fresh = this.cache.get(cacheKey);
  if (fresh) {
    return { source, outcome: 'cached', data: fresh.value as T,
             latencyMs: round(performance.now() - started), ageMs: fresh.ageMs, attempts: 0 };
  }
```

**Fresh cache hit — return immediately.** `attempts: 0` records that no network
call happened. Note `get()`, not `getAllowStale()`: on the happy path we want
fresh data only.

```ts
  const breaker = this.breakerFor(source);
  if (breaker.shouldTrip()) {
    trace.note(`${source}: circuit open, skipped upstream call`);
    return this.staleOrFail(source, cacheKey, started, 'circuit open', 0);
  }
```

**Circuit check before the call.** If the source is known-down we skip straight to
stale-or-fail, spending microseconds instead of 2×1200ms.

```ts
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
      { attempts: this.cfg.UPSTREAM_RETRY_ATTEMPTS, /* … */ },
    );
```

Three nested layers, outermost first: **retry** wraps **timeout** wraps **fetch**.
So each *attempt* gets its own fresh 1200ms budget — which is what you want.

`if (!res.ok) throw` is necessary because **`fetch` does not reject on 4xx/5xx**.
Without this line a 503 body would be parsed as if it were a kundli.

The `x-request-id` header propagates the trace id, so upstream logs can be
correlated with ours.

```ts
    breaker.recordSuccess();
    this.cache.set(cacheKey, data, ttl.freshMs, ttl.staleMs);
    return { source, outcome: 'ok', data, latencyMs: round(performance.now() - started), attempts };
  } catch (err) {
    breaker.recordFailure();
    this.logger.warn('upstream.failed', { requestId: trace.requestId, source, attempts,
                                          reason: errMessage(err), circuit: breaker.getState() });
    return this.staleOrFail(source, cacheKey, started, errMessage(err), attempts);
  }
}
```

**The `catch` returns rather than rethrows.** This is the single most important
line in the file — it is what makes failure a value.

### `staleOrFail()`

```ts
private staleOrFail<T>(source, cacheKey, started, error, attempts): SourceResult<T> {
  const stale = this.cache.getAllowStale(cacheKey);
  if (stale) {
    return { source, outcome: 'stale', data: stale.value as T, error,
             latencyMs: round(performance.now() - started), ageMs: stale.ageMs, attempts };
  }
  return { source, outcome: 'failed', error, latencyMs: round(performance.now() - started), attempts };
}
```

Now `getAllowStale()` is used — the fetch failed, so expired data becomes
acceptable. Note `error` is kept even on the stale path: we succeeded in
*serving*, but something did fail, and the trace should say so.

### `breakerFor()` — lazy per-source breakers

```ts
private breakerFor(source: UpstreamName): CircuitBreaker {
  let b = this.breakers.get(source);
  if (!b) { b = new CircuitBreaker(); this.breakers.set(source, b); }
  return b;
}
```

One breaker **per source**, created on first use. A failing Panchang service must
not open the circuit for Kundli.

---

## `context-aggregator.service.ts` — the fan-out

### The slot pattern

```ts
const slots: Record<UpstreamName, SourceResult<unknown> | undefined> = {
  user: undefined, kundli: undefined, horoscope: undefined, panchang: undefined,
};

const track = <T>(name: UpstreamName, p: Promise<SourceResult<T>>) =>
  p.then((r) => { slots[name] = r; return r; });
```

Each promise **records itself into a slot** the moment it resolves. After the
deadline we simply read the slots — whatever landed is there, whatever did not is
`undefined`.

This replaced an earlier version using `Promise.race` with `setImmediate`, which
worked but relied on subtle microtask-vs-macrotask ordering. The slot version is
obviously correct on first read. *Clearer beats cleverer.*

### The deadline

```ts
const hitDeadline = await Promise.race([
  Promise.all(tasks).then(() => false),
  sleep(this.cfg.CONTEXT_FANOUT_DEADLINE_MS).then(() => true),
]);
```

Whichever resolves first wins, and the boolean says which. Two layers of
protection:

- **Per-source timeout (1200ms)** — bounds one call.
- **Stage deadline (2500ms)** — bounds the whole stage even if several sources are
  slow simultaneously.

```ts
const bundle: ContextBundle = {
  user: (slots.user ?? abandoned('user')) as SourceResult<UserProfile>,
  // …
};
```

`??` fills unresolved slots with a `failed` placeholder. The downstream pipeline
cannot tell the difference between "the service errored" and "the service was too
slow" — and does not need to.

### Proving the concurrency

```ts
this.logger.info('context.gathered', {
  fanoutMs: Math.round(elapsed),
  serialisedMs: Math.round(results.reduce((a, r) => a + r.latencyMs, 0)),
  // …
});
```

`fanoutMs` is wall time; `serialisedMs` is the sum. In a real run: **54ms vs
201ms**. The concurrency win is *measured*, not asserted.

---

## `mock/mock-upstream.server.ts` and `mock/fixtures.ts`

### Why a real HTTP server

Stubbing at the service boundary would leave the retry, timeout, abort and
partial-failure code **untested** — it would only ever execute in production. The
mock is a plain `node:http` server on its own port, so the same code path runs
whether `UPSTREAM_*_URL` points here or at production.

Using Node's built-in `http` rather than a framework also signals what it is: a
stand-in for *external* services, not part of our application.

### Fault injection

```ts
const jitter = cfg.MOCK_UPSTREAM_LATENCY_MS * (0.5 + Math.random());
await sleep(jitter);

const forced = url.searchParams.get('fail') === '1';
if (forced || Math.random() < cfg.MOCK_UPSTREAM_FAULT_RATE) {
  return json(res, 503, { error: 'Service temporarily unavailable' });
}
```

`MOCK_UPSTREAM_FAULT_RATE=0.9` makes degradation **demonstrable**, not theoretical.
`?fail=1` forces a specific failure for scripted demos.

### The fixtures are astrologically real

```ts
user_101: {
  lagna: 'Libra',
  moonSign: 'Scorpio',
  currentDasha: { mahadasha: 'Rahu', antardasha: 'Mars' },
  houses: {
    '6':  { lord: 'Jupiter', strength: 'Average' },   // Libra + 6 → Pisces → Jupiter ✓
    '7':  { lord: 'Mars',    strength: 'Weak'    },   // Libra + 7 → Aries  → Mars    ✓
    '10': { lord: 'Moon',    strength: 'Strong'  },   // Libra + 10 → Cancer → Moon   ✓
  },
},
```

Every house lord is what the stated lagna actually produces. The validator checks
this property at runtime, so a broken fixture would fail its own test.

Three users exercise three code paths:

| User | Purpose |
|---|---|
| `user_101` | exact birth time → full-confidence path |
| `user_102` | approximate time, Hindi, free tier → reduced budget |
| `user_103` | **unknown birth time** → house suppression, Moon-sign fallback |

### The panchang is honestly labelled

```ts
// NOTE: this is a deterministic stand-in, NOT a real ephemeris calculation.
export function panchangFor(dateIso: string) {
  const dayIndex = Math.floor(Date.parse(`${dateIso}T00:00:00Z`) / 86_400_000);
  const tithiIndex = mod(dayIndex, 30);
  // …cycles the canonical 27 nakshatras, 27 yogas, 11 karanas
}
```

Real names, deterministic, always current-looking — but it does **not** compute
planetary longitudes. The comment says so, because quietly implying real
astronomical calculation would be dishonest.

### The transits move, honestly labelled too

```ts
const TRANSIT_EPOCH_MS = Date.parse('2026-09-15T00:00:00Z');
const TRANSIT_MODEL = {
  Saturn:  { lon: 330 + 7,  perDay:  0.03347 },  // 360 / (29.457 y × 365.25 d)
  Jupiter: { lon: 90 + 10,  perDay:  0.08309 },
  Rahu:    { lon: 300 + 4,  perDay: -0.05295 },  // the nodes move backwards
};

export function transitsFor(dateIso: string): Transits {
  const days = (Date.parse(`${dateIso}T00:00:00Z`) - TRANSIT_EPOCH_MS) / 86_400_000;
  // lon = epoch + perDay × days, mod 360; sign = floor(lon / 30), degree = lon % 30
  // Ketu = Rahu + 180°
}
```

Positions are propagated from a reference epoch by **mean** daily motion. That
ignores retrograde loops entirely — real Saturn spends about a third of every
year moving backwards; this one never does. What it preserves is the thing the
engine actually reasons about (which sign, roughly how far through), and it
lets the sky *move*: ask for `?date=2028-09-15` and Saturn has left Pisces,
which is how the "watch Sade Sati end" experiment in docs/11 works.

The route is `GET /transits`. Unlike the panchang it genuinely needs no
location: geocentric sidereal positions are the same everywhere on Earth.
