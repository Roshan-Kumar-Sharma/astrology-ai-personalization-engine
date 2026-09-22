# 4. Low-Level Design

Module-by-module reference. Signatures are simplified for readability; the code
is the authority.

## Directory map

```
src/
├─ main.ts                       bootstrap: dotenv → Nest app → mock upstream → listen
├─ app.module.ts                 composition root (flat, deliberately)
│
├─ common/
│  ├─ core.module.ts             @Global: config + logger
│  ├─ config/app.config.ts       zod-validated env, fail-fast at boot
│  ├─ logging/
│  │  ├─ logger.ts               structured JSON, redaction
│  │  ├─ request-trace.ts        per-request spans + decisions
│  │  └─ request-logging.middleware.ts
│  ├─ cache/ttl-cache.ts         TTL + stale-while-revalidate
│  └─ resilience/
│     ├─ retry.ts                withTimeout, retry (full jitter)
│     └─ circuit-breaker.ts
│
├─ upstream/                     external service access
│  ├─ types.ts                   UserProfile, Kundli, Horoscope, Panchang, SourceResult, ContextBundle
│  ├─ cache-policy.ts            domain-derived TTLs, source criticality
│  ├─ upstream.client.ts         one generic resilient client for all four
│  ├─ context-aggregator.service.ts  concurrent fan-out
│  └─ mock/                      stand-in services over real HTTP
│
├─ astrology/                    PURE DOMAIN — no framework, no I/O
│  ├─ zodiac.ts                  signs, lords, dignity, house meanings
│  ├─ vimshottari.ts             dasha arithmetic, nakshatra lords
│  ├─ chart-validation.ts        consistency + birth-time reliability
│  ├─ inference.service.ts       derived facts
│  └─ types.ts                   DerivedFact, ChartReliability, DomainCategory
│
├─ personalization/              THE ENGINE
│  ├─ types.ts                   Intent, Horizon, ContextItem, PersonalizationPlan
│  ├─ config/
│  │  ├─ intent-rules.config.ts  ← selection behaviour lives here
│  │  └─ style.config.ts         ← language/tone/length behaviour lives here
│  ├─ intent/
│  │  ├─ lexicon.ts              weighted multilingual terms
│  │  ├─ intent.classifier.ts
│  │  └─ horizon.extractor.ts
│  ├─ context-item.builder.ts    bundle + facts → ContextItem[]
│  ├─ context.selector.ts        filter → score → floor → pack
│  ├─ style.resolver.ts
│  └─ personalization.service.ts composes the above into a plan
│
├─ safety/
│  ├─ policies.config.ts         ← risk policy table
│  └─ guardrails.service.ts      input screen + output review
│
├─ llm/
│  ├─ llm.provider.ts            LlmProvider interface + DI token
│  ├─ llm.module.ts              provider selection (the only place)
│  ├─ tokenizer.ts               script-aware token estimation
│  ├─ prompt/prompt.builder.ts
│  └─ providers/                 anthropic · openai (+openrouter) · mock
│
├─ answer/
│  ├─ groundedness.service.ts    parse, verify, sourcesUsed
│  └─ confidence.service.ts      weighted factors + hard caps
│
└─ api/
   ├─ personalize.controller.ts
   ├─ debug.controller.ts
   ├─ health.controller.ts
   ├─ personalize.service.ts     the 10-stage pipeline
   └─ dto/personalize.dto.ts
```

---

## Core data structures

### `SourceResult<T>` — a fetch outcome, never an exception

```ts
interface SourceResult<T> {
  source: 'user' | 'kundli' | 'horoscope' | 'panchang';
  outcome: 'ok' | 'cached' | 'stale' | 'failed' | 'skipped';
  data?: T;
  error?: string;
  latencyMs: number;
  ageMs?: number;     // when served from cache
  attempts: number;
}
```

Making failure a *value* rather than an exception is what lets the whole pipeline
reason about partial data instead of collapsing into a try/catch.

### `ContextItem` — the atomic unit of selection

```ts
interface ContextItem {
  id: string;              // 'kundli.house.10' — dotted, matched by rule patterns
  label: string;           // '10th House' — surfaces in sourcesUsed
  displayGroup?: string;   // "Today's Panchang" — collapses 4 limbs into 1 source
  source: UpstreamName | 'derived';
  categories: DomainCategory[];
  text: string;            // rendered into the prompt
  tokens: number;
  confidence: 'high' | 'medium' | 'low';
  basis: string[];         // provenance: which raw fields produced this
  stale?: boolean;
  supersedes?: string[];   // ids this item makes redundant
}
```

**Why flatten?** Upstream data arrives as five nested documents, but relevance is
per-fact: the 10th house matters for career, the 7th in the same document does
not. Keeping documents whole forces an all-or-nothing choice.

### `PersonalizationPlan` — the complete decision record

```ts
interface PersonalizationPlan {
  intent; intentConfidence; intentMethod; secondaryIntents;
  horizon;
  style: { languageCode, tier, language, tone, maxWords, jargonLevel };
  selected: ScoredItem[];        // score + tier + human-readable reason
  excluded: ExcludedItem[];      // reason + detail per item
  tokenBudget; tokensUsed; tokensAvailable; naiveBaselineTokens;
  reliability: ChartReliability;
  constraints: string[];         // safety directives for the prompt
  notes: string[];
}
```

One object drives the prompt, the logs, and the debug endpoint. That unity is
why the explanation cannot drift from the behaviour.

---

## Module detail

### `common/config/app.config.ts`

Zod schema over `process.env`, parsed once and cached. Invalid config throws at
boot with a field-level message rather than surfacing on the first request.

```ts
loadConfig(env = process.env): AppConfig   // pure, testable
appConfig(): AppConfig                     // cached singleton
export const APP_CONFIG = Symbol('APP_CONFIG');  // DI token
```

> **Caching gotcha:** `dotenv/config` must be imported before the first
> `appConfig()` call, which is why it is the first line of `main.ts`.

### `common/logging/request-trace.ts`

```ts
class RequestTrace {
  time<T>(name, fn): Promise<T>      // async stage, records a span
  timeSync<T>(name, fn): T
  note(message: string): void        // human-readable decision
  getSpans(); getNotes(); totalMs(); latencyBreakdown();
}
```

### `common/cache/ttl-cache.ts`

```ts
set(key, value, freshMs, staleMs)
get(key)             // fresh only
getAllowStale(key)   // fresh OR stale, caller decides
```

Two-tier expiry is the point: `freshUntil` for normal reads, `expiresAt` for the
degraded path. Serving a 40-minute-old horoscope beats an error page.

### `common/resilience/retry.ts`

```ts
withTimeout(ms, label, fn(signal))   // AbortController-based
retry(fn, { attempts, baseDelayMs, isRetryable, onRetry })
```

**Full jitter**: `delay = random(0, base × 2^n)`. Not fixed backoff, because
every request fans out to five upstreams simultaneously — without jitter a blip
causes all callers to retry in lockstep and stampede the recovering service.

`isRetryable` excludes 4xx: a 404 will fail identically on retry.

### `upstream/upstream.client.ts`

One generic client for all five services. Resilience is cross-cutting, so it
lives here once rather than being reimplemented per service.

```
fetch(source, baseUrl, path, trace) → SourceResult<T>
  ├─ cache hit (fresh)     → return immediately
  ├─ circuit open          → skip call, try stale
  ├─ retry(withTimeout(fetch))
  │    ├─ success          → cache, return ok
  │    └─ failure          → try stale, else failed
```

### `astrology/vimshottari.ts` — the domain's sharpest edge

```ts
DASHA_SEQUENCE = [Ketu, Venus, Sun, Moon, Mars, Rahu, Jupiter, Saturn, Mercury]
DASHA_YEARS    = { Ketu: 7, Venus: 20, Sun: 6, Moon: 10, Mars: 7,
                   Rahu: 18, Jupiter: 16, Saturn: 19, Mercury: 17 }  // = 120

antardashaSequence(md)      // cyclic order starting at md itself
antardashaYears(md, ad)     // md × ad / 120
locateDasha(md, ad) → { antardashaIndex, isFinalAntardasha, antardashaMonths,
                        nextMahadasha, chapterProgress, phase }
nakshatraLord(nakshatra)    // 27 nakshatras cycle through the same 9 lords
```

Worked example — the brief's own sample data:
```
Rahu mahadasha, Mars antardasha
sequence from Rahu: Rahu Jup Sat Mer Ket Ven Sun Moon [Mars]  ← 9th of 9
duration: 18 × 7 / 120 = 1.05 years = 12.6 months
⇒ closing sub-period of an 18-year chapter; Jupiter mahadasha begins next
```

### `astrology/chart-validation.ts`

```ts
assessChart(kundli, user) → { birthTime, housesUsable, inconsistencies[], notes[] }
assessBirthTime(user)     → 'exact' | 'approximate' | 'unknown'
```

House lords are fully determined by the lagna, so the check is free:

```
Libra lagna ⇒ 6th house = Pisces ⇒ lord Jupiter  ✓ matches payload
            ⇒ 7th house = Aries  ⇒ lord Mars     ✓
            ⇒ 10th house = Cancer⇒ lord Moon     ✓
```

A mismatch means the upstream has a data bug. We flag it and cap confidence
rather than silently overriding — the upstream is the system of record.

Birth-time heuristic when upstream gives no `timeAccuracy`: a time landing
exactly on the hour or half hour is more likely remembered than recorded.

### `personalization/context.selector.ts`

```ts
select({ items, intent, secondaryIntents, horizon, tokenBudget, reliability })
  → { selected: ScoredItem[], excluded: ExcludedItem[], tokensUsed, tokensAvailable, notes }
```

Seven ordered steps (see [Request Lifecycle](02-request-lifecycle.md) stage 6).
Contains **no astrology and no per-intent `if`**. Its only job is applying the
rules consistently.

Scoring:
```
score = TIER_WEIGHT              (primary 100 / secondary 55 / neutral 15)
      + horizon adjustment       (promote +60 / demote −45)
      × data confidence          (1.0 / 0.85 / 0.6)
      × stale penalty            (0.75 if served stale)
```

Budget packing is greedy by priority but **continues past a miss**, so one
expensive item cannot block every cheaper item behind it.

### `safety/guardrails.service.ts`

```ts
screenQuestion(question) → { blocked, matchedPolicies, rationale, constraints, blockResponse, escalateToHuman }
reviewAnswer(answer)     → { answer, violations, replaced }
```

Two matching modes:
- `patterns` — any one match fires the policy
- `allOf` — every group must match, any pattern within a group

`allOf` exists because a single regex is too brittle for the highest-risk case:
`"Will my mother's cancer be cured?"` slips past a pattern written for
`"will cancer be cured"` — the possessive breaks it. Splitting into
`[disease terms] AND [prognosis verbs]` is both more robust and easier to review.

### `llm/llm.provider.ts` — the swap point

```ts
interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: LlmRequest, signal?): Promise<LlmResponse>;
}
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
```

`systemStatic` and `systemDynamic` are separate fields so providers supporting
prompt caching can mark exactly the invariant span as cacheable.

Provider selection happens once, in `llm.module.ts`. Nothing downstream knows
which is active. OpenRouter needed no new class — its API is OpenAI-compatible,
so it is the same adapter with a different base URL and two headers.

### `answer/groundedness.service.ts`

```ts
parse(raw)                        → { answer, citedIds, usedFallbackParse }
verify(parsed, selected)          → { verifiedIds, fabricatedIds, ungroundedEntities, contractIgnored, score }
sourcesUsed(report, selected)     → string[]
```

Detection covers planets, all twelve signs, and houses referenced as digits
(`10th house`, `house 10`) or ordinal words (`tenth house`).

### `api/personalize.service.ts` — the pipeline

Sequences the stages and decides what to do when one degrades. Contains no
domain logic, which is what lets the whole flow be read top to bottom.

---

## Dependency rules

```
api ──► personalization ──► astrology
 │           │                 ▲
 │           ├──► upstream ────┘
 ├──► safety │
 ├──► answer ┘
 └──► llm
      all ──► common
```

- `astrology/` imports **nothing** from NestJS, `upstream/`, or `llm/`.
- `personalization/` never performs I/O.
- `api/` holds no domain logic.
- Nothing imports `api/`.

Enforced by convention and directory structure rather than by a lint rule — a
gap worth closing with `eslint-plugin-boundaries` in a longer-lived project.

## Testing map

| Suite | Tests | Covers |
|-------|-------|--------|
| `guardrails.spec.ts` | 26 | Every policy, **and false positives** |
| `answer.spec.ts` | 21 | Groundedness detection, confidence factors and caps |
| `intent.spec.ts` | 21 | Sample questions, Hinglish/Devanagari, horizon ordering |
| `personalize.e2e.spec.ts` | 20 | Both endpoints over real HTTP, degradation, validation |
| `context.selector.spec.ts` | 16 | Exclusions, horizon drops, supersession, budget, reliability |
| `vimshottari.spec.ts` | 9 | Dasha arithmetic, the Rahu–Mars property |
| `ttl-cache.spec.ts` | 9 | Stale-while-revalidate, eviction, IST boundaries |
| `chart-validation.spec.ts` | 8 | Lagna/lord consistency, birth-time heuristics |
| **Total** | **130** | |

The e2e suite runs over real HTTP against the mock upstream on its own port —
deliberately not stubbed at the service boundary, because the concurrency,
retry and timeout paths only mean something if a socket is involved.
