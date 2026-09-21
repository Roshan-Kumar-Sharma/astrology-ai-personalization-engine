# 6. Answer & API — `src/answer/`, `src/api/`, `src/main.ts`

The last layer. By now every name should be familiar.

---

## `answer/groundedness.service.ts`

### `parse()` — defensive by design

```ts
parse(raw: string): ParsedModelOutput {
  const trimmed = stripReasoning(raw).trim();
  const jsonText = extractJsonObject(trimmed);

  if (jsonText) {
    try {
      const obj = JSON.parse(jsonText) as { answer?: unknown; usedContextIds?: unknown };
      if (typeof obj.answer === 'string' && obj.answer.trim()) {
        return {
          answer: obj.answer.trim(),
          citedIds: Array.isArray(obj.usedContextIds)
            ? obj.usedContextIds.filter((i): i is string => typeof i === 'string')
            : [],
          usedFallbackParse: false,
        };
      }
    } catch { /* fall through */ }
  }
  return { answer: trimmed, citedIds: [], usedFallbackParse: true };
}
```

Every layer assumes the model may misbehave:

- `typeof obj.answer === 'string'` — it might return a number or an object.
- `.filter((i): i is string => …)` — the array might contain non-strings. The
  `i is string` **type predicate** narrows `unknown[]` to `string[]`.
- Empty `catch` — malformed JSON falls through rather than throwing.
- The final return never fails: worst case, the whole reply becomes the answer
  and `usedFallbackParse` records it.

### `stripReasoning()`

```ts
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '');
}
```

`[\s\S]` matches any character **including newlines** (unlike `.`). `*?` is
lazy, so it stops at the first closing tag rather than the last.

The third replace handles a truncated opening tag — some models emit `</think>`
without a matching `<think>`.

**Why this exists:** a large share of free-tier models are reasoning models, and
several emit chain-of-thought as ordinary content. Without this, the user
receives the model's raw thinking as their astrology answer. That actually
happened on the first live run.

### `extractJsonObject()`

```ts
function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}
```

Handles markdown fences first, then takes **first `{` to last `}`** — tolerating
prose before or after ("Sure! Here's the JSON: …").

### `verify()` — the hallucination check

```ts
const selectedIds = new Set(selected.map((i) => i.id));
const verifiedIds  = parsed.citedIds.filter((id) => selectedIds.has(id));
const fabricatedIds = parsed.citedIds.filter((id) => !selectedIds.has(id));
```

A set intersection: cited ids that exist versus cited ids we never sent.

```ts
const vocabulary = selected.map((i) => `${i.label} ${i.text}`).join(' ').toLowerCase();
const answer = parsed.answer.toLowerCase();
const ungrounded: string[] = [];

for (const planet of PLANETS) {
  if (new RegExp(`\\b${planet}\\b`).test(answer) && !vocabulary.includes(planet)) {
    ungrounded.push(planet);
  }
}
```

The entire logic of the anti-hallucination check: **build a vocabulary of
everything we sent, then flag any astrological entity in the answer that is not in
it.** Because we know exactly what went in, anything else is invented by
construction.

`\\b…\\b` on the answer prevents "sun" matching inside "Sunday"; plain
`includes` on the vocabulary is fine because a false *negative* there only means
we fail to flag something.

```ts
for (const house of housesMentioned(answer)) {
  const inContext = selected.some((i) => i.id.endsWith(`.house.${house}`))
                 || new RegExp(`house ${house}\\b`).test(vocabulary);
  if (!inContext) ungrounded.push(`house ${house}`);
}
```

Two ways a house can be legitimately present: as a selected item id, or mentioned
inside another item's text.

```ts
function housesMentioned(answer: string): number[] {
  const found = new Set<number>();
  for (const m of answer.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+house\b/g)) found.add(Number(m[1]));
  for (const m of answer.matchAll(/\bhouse\s+(\d{1,2})\b/g)) found.add(Number(m[1]));
  for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\s+house\\b`).test(answer)) found.add(n);
  }
  return [...found].filter((n) => n >= 1 && n <= 12);
}
```

Three phrasings — "10th house", "house 10", "tenth house" — because a model will
use all three.

### The penalty

```ts
const penalty = Math.min(1,
  ungrounded.length * 0.3
  + fabricatedIds.length * 0.1
  + (parsed.usedFallbackParse ? 0.35 : 0));
```

Three severities, deliberately weighted:

| Signal | Weight | Reasoning |
|---|---|---|
| Ungrounded entity | 0.30 | Invented a fact — the worst per-item failure |
| Fabricated citation | 0.10 | Cited sloppily, may still be reasoning correctly |
| **Contract ignored** | 0.35 | Cannot verify *anything* |

The `contractIgnored` term was added after a real defect: a model returned raw
reasoning, we fell back to plain text, and the response still reported `HIGH`
confidence. Without a citation list there is nothing to verify, so confidence
must reflect that.

### `sourcesUsed()`

```ts
const chosen = report.verifiedIds.length
  ? report.verifiedIds.map((id) => byId.get(id)).filter(isDefined)
  : [...selected].sort((a, b) => b.score - a.score).slice(0, fallbackCount);

return [...new Set(chosen.map((i) => i.displayGroup ?? i.label))];
```

Prefers what the model **verifiably** cited. If it cited nothing usable, falls
back to the highest-ranked context — the best available account of what the
answer rests on.

`displayGroup ?? label` collapses four panchang limbs into one `"Today's
Panchang"`, and `new Set` dedupes.

---

## `answer/confidence.service.ts`

### The weights

```ts
const WEIGHTS = {
  dataCompleteness: 0.3,
  contextCoverage: 0.2,
  intentCertainty: 0.15,
  birthTimeReliability: 0.2,
  groundedness: 0.15,
} as const;

const HIGH_THRESHOLD = 0.75;
const MEDIUM_THRESHOLD = 0.55;
```

Sums to 1.0, so the score is naturally in `[0, 1]`.

### Data completeness

```ts
let completeness = 0;
for (const r of bundleResults(bundle)) {
  const criticality = SOURCE_CRITICALITY[r.source];
  const value = r.outcome === 'ok' || r.outcome === 'cached' ? 1
              : r.outcome === 'stale' ? 0.6
              : 0;
  completeness += criticality * value;
  if (value < 1) degraded.push(`${r.source}:${r.outcome}`);
}
```

Weighted by how much each source matters (kundli 0.45, panchang 0.10) rather than
counting sources equally. `cached` scores the same as `ok` — it is identical data.
`stale` scores 0.6 because it is real but expired.

### Context coverage

```ts
const primaryCount = plan.selected.filter((i) => i.tier === 'primary').length;
const coverage = primaryCount >= 2 ? 1 : primaryCount === 1 ? 0.7 : 0.3;
```

Not "how many items" but "did we find context that **primarily** addresses this
question?" Ten tangential items are worth less than two directly relevant ones.

### Birth time

```ts
const birthValue = plan.reliability.birthTime === 'exact' ? 1
                 : plan.reliability.birthTime === 'approximate' ? 0.7
                 : 0.4;
```

### The hard caps

```ts
let score = factors.reduce((sum, f) => sum + f.weight * f.value, 0);

if (bundle.kundli.outcome === 'failed') {
  score = Math.min(score, 0.5);
  caps.push('Kundli unavailable: no personalised chart analysis was possible.');
}
if (bundle.kundli.outcome === 'failed' && bundle.horoscope.outcome === 'failed') {
  score = Math.min(score, 0.35);
  caps.push('Both kundli and horoscope unavailable: the answer is effectively generic.');
}
if (!plan.reliability.housesUsable) {
  score = Math.min(score, 0.7);
  caps.push('Birth time cannot support house division; reasoning limited to the Moon sign…');
}
```

**Why caps in addition to weights?** Some failures are *categorical*, not gradual.

The birth-time cap is the clearest example. With weights alone, an unknown birth
time scored **0.82 — still `HIGH`** — because the 0.20 factor at 0.4 only cost
0.12. But losing house division loses the ascendant, every bhava and every house
lord *at once*. Reporting `HIGH` would tell the user the answer is solid when half
the chart was unreadable. `Math.min(score, 0.7)` forces `MEDIUM`.

This was found by running the pipeline and noticing `user_103` reported `HIGH`
when it obviously should not have.

Every cap pushes a human-readable string, so the debug endpoint explains *why*
confidence was limited rather than just showing a number.

---

## `api/dto/personalize.dto.ts`

```ts
export class PersonalizeRequestDto {
  @IsString()
  @Matches(/^[\w-]{1,64}$/, { message: 'userId must be 1-64 word characters or hyphens' })
  userId!: string;

  @IsString()
  @Length(3, 1000, { message: 'question must be between 3 and 1000 characters' })
  question!: string;

  @IsOptional()
  @IsBoolean()
  @Transform(({ value }) => value === true || value === 'true')
  verbose?: boolean;
}
```

`@Matches` on `userId` is defence in depth — the id goes into a URL path, so
constraining the character set prevents path traversal or injection.

The 1000-character cap is a **cost and safety control**, not just hygiene: it
bounds a single request's token spend and blunts prompt-stuffing.

`@Transform` accepts both `true` and `"true"`, because query strings and JSON
bodies disagree about booleans.

The `!` in `userId!: string` is TypeScript's definite-assignment assertion — the
value is populated by the framework, not by a constructor.

---

## `api/personalize.service.ts` — the pipeline

The orchestrator. **Contains no domain logic** — it sequences stages and decides
what to do when one degrades.

### Safety first

```ts
const guardrail = trace.timeSync('safety.screen', () => this.guardrails.screenQuestion(question));

if (guardrail.blocked) {
  this.logger.warn('safety.blocked', { requestId: trace.requestId, userId, policies: guardrail.matchedPolicies });
  return {
    answer: guardrail.blockResponse ?? FALLBACK_REFUSAL,
    confidence: 'HIGH',
    sourcesUsed: [],
    meta: cmd.verbose ? { blocked: true, policies: …, rationale: …, escalateToHuman: … } : undefined,
  };
}
```

The early return is the whole point: **no fetch, no LLM, no cost**.

`confidence: 'HIGH'` may look odd. We are fully confident in the refusal — it is
not a hedge. `sourcesUsed: []` because no chart data was used.

### The LLM call with fallback

```ts
private async generate(prompt, trace): Promise<LlmResponse> {
  try {
    return await withTimeout(this.cfg.LLM_TIMEOUT_MS, 'llm generate', (signal) =>
      this.llm.generate(prompt, signal));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.error('llm.failed', { requestId: trace.requestId, provider: this.llm.name, reason });
    trace.note(`LLM provider "${this.llm.name}" failed (${reason}); used the offline fallback.`);
    const fallback = await this.mockFallback.generate(prompt);
    return { ...fallback, degraded: true };
  }
}
```

If the configured provider fails, the **deterministic local provider** answers
instead. An offline answer is a much smaller failure than a 500 — and
`degraded: true` propagates so the confidence label is downgraded and the event
appears in logs rather than passing silently.

### Confidence adjustment

```ts
const label = generation.degraded || reviewed.replaced ? downgrade(confidence.label) : confidence.label;
const sourcesUsed = reviewed.replaced ? [] : this.groundedness.sourcesUsed(report, plan.selected);
```

Two post-hoc adjustments the calculator cannot know about: a degraded provider,
and an answer replaced by the output guardrail. If the answer was replaced,
`sourcesUsed` must be empty — the replacement text rests on nothing.

### The completion log

```ts
this.logger.info('request.completed', {
  requestId, userId, intent: plan.intent, horizon: plan.horizon,
  confidence: label, confidenceScore: confidence.score,
  totalMs: trace.totalMs(), latency: trace.latencyBreakdown(),
  provider: generation.provider, model: generation.model,
  usage: generation.usage, degraded: generation.degraded ?? false,
});
```

One line carrying everything needed to answer "what happened to this request?" —
which is why `RequestTrace` accumulates rather than logging as it goes.

---

## `api/debug.controller.ts`

```ts
const guardrail = this.guardrails.screenQuestion(body.question);
const bundle = await this.aggregator.gather(body.userId, trace);
const plan = this.personalization.plan({ question: body.question, bundle, guardrail, trace });

const prompt = this.promptBuilder.build(body.question, plan);
const confidence = this.confidence.compute({ bundle, plan });
```

**The same services, in the same order, minus generation.** Not a parallel
implementation — which is why what it reports is necessarily what happens.

The prompt is built but never sent, so the response can include the exact text
the model *would* have received.

```ts
excludedContext: dedupe(plan.excluded.map((i) => i.label))
  .filter((label) => !selectedLabels.includes(label)),
```

A label can appear on both lists when a raw field was superseded by the derived
fact that restates it — "10th House" excluded as redundant while "10th House" is
selected. That is an internal optimisation, not a selection decision, so it is
filtered from the summary. The full record stays in `explain.excluded`.

---

## `api/console.controller.ts`, `console.html`, `console.presets.ts`

The debug console: one static page that drives `/debug/personalization`. Three
small files and one rule.

```ts
@Controller('console')
@UseGuards(DebugEnabledGuard)
export class ConsoleController {
  page(): string { /* readFileSync(join(__dirname, 'console.html')) */ }
  bootstrap() { /* users, provider, flags, budgets, presets */ }
}
```

**The rule: the console computes nothing.** Every number it renders is a field in
the payload. It owns no scoring, no horizon logic, no exclusion vocabulary — so
it cannot disagree with the engine. A debug UI that recomputes anything
eventually drifts, and then you have two stories about what the user got.

`page()` re-reads the file on every request outside production, so editing the
HTML and hitting reload is the whole dev loop. In production it is read once. If
the file is missing — the classic symptom of a compiled build without the
`assets` entry in `nest-cli.json` — the error says exactly that instead of
surfacing an `ENOENT`.

`bootstrap()` describes the **running** service rather than the one the page was
written against: the configured provider and model, the feature-flag states, the
budgets, and the fixture user ids. The provider is on screen at all times for a
specific reason — a failed provider degrades to the local mock, which returns
fluent, chart-shaped prose, and reading that as a live model's answer is a
mistake this project has made more than once.

```ts
export interface ConsolePreset {
  label: string;  userId: string;  question: string;
  demonstrates: string;                 // shown to the reader
  expect: { intent?; horizon?; blocked?; policy?; language?; housesUsed?; panchangUsed? };
}
```

The preset chips each make a claim in prose, and prose does not fail a build. So
the claim is also written as data, and `test/personalize.e2e.spec.ts` asserts
every one of them — a button that stops demonstrating what it says breaks the
suite by name.

### `api/debug-enabled.guard.ts`

```ts
canActivate(): boolean {
  if (!this.cfg.DEBUG_ENDPOINTS_ENABLED) throw new NotFoundException();
  return true;
}
```

Applied to **both** debug controllers. Hiding the console while leaving the JSON
endpoint open would be theatre — the page shows nothing the endpoint does not
return. `404` rather than `403`, because a 403 confirms the route is there.

---

## `main.ts` — bootstrap

```ts
// Must be first: populates process.env from .env before anything reads config.
import 'dotenv/config';
import 'reflect-metadata';
```

**Import order is load-bearing.** `appConfig()` validates and caches on first
call, so a later `.env` load would be silently ignored. Getting this wrong was a
real bug — `npm start` ignored `.env` entirely and silently used the mock
provider.

`reflect-metadata` must be imported once before any decorator runs; NestJS uses
it for DI type reflection.

```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,               // strip unknown properties
  forbidNonWhitelisted: true,    // …and reject them with 400
  transform: true,               // apply @Transform, coerce types
  transformOptions: { enableImplicitConversion: false },
}));
```

`whitelist` + `forbidNonWhitelisted` together mean an unexpected field is a `400`,
not silently ignored. `enableImplicitConversion: false` keeps coercion explicit —
implicit conversion turns `"abc"` into `NaN` rather than failing.

```ts
if (cfg.MOCK_UPSTREAM_ENABLED) {
  const server = await startMockUpstream(cfg, logger);
  process.on('SIGTERM', () => server.close());
  process.on('SIGINT', () => server.close());
}
```

The mock runs in-process on a second port, so one `npm start` gives a working
system. Signal handlers close it cleanly — without them the port stays bound
after Ctrl-C, which caused an `EADDRINUSE` during development.

```ts
bootstrap().catch((err) => {
  process.stderr.write(JSON.stringify({ ts: …, level: 'error', event: 'server.boot_failed',
                                        reason: err instanceof Error ? err.message : String(err) }) + '\n');
  process.exit(1);
});
```

Boot failures are logged as **structured JSON** too, so a crash-looping container
produces parseable output rather than a stack trace wall.

---

## Where to go next

You have now read every file. Two things worth doing:

**1. Trace one value yourself.** Pick `plan.selected` and follow it: built in
`context-item.builder.ts`, filtered in `context.selector.ts`, rendered in
`prompt.builder.ts`, verified in `groundedness.service.ts`, counted in
`confidence.service.ts`. Five files, one array.

**2. Change something and watch it move.** Set `MIN_SCORE_THRESHOLD` to 60 in
`intent-rules.config.ts`, restart, and open <http://localhost:3000/console>.
Watch items move from the selected column to the excluded one under
`rule:below-threshold`, and watch the "vs previous run" line name every item that
moved. That single edit demonstrates the whole config-driven design.
