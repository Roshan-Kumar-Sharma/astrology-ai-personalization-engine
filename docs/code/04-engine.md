# 4. The Engine — `src/personalization/`

The heart of the assignment. Read `types.ts`, then the config, then the logic.

---

## `types.ts` — the vocabulary

### `ContextItem`

```ts
export interface ContextItem {
  id: string;              // 'kundli.house.10' — dotted, matched by rule patterns
  label: string;           // '10th House' — appears in sourcesUsed
  displayGroup?: string;   // "Today's Panchang" — collapses 4 limbs into 1 source
  source: UpstreamName | 'derived';
  categories: DomainCategory[];
  text: string;            // the sentence placed in the prompt
  tokens: number;
  confidence: 'high' | 'medium' | 'low';
  basis: string[];
  ageMs?: number;
  stale?: boolean;
  supersedes?: string[];
}
```

Three fields deserve attention:

- **`id`** is dotted so rule patterns can use prefixes: `derived.dasha.*` matches
  `derived.dasha.position`, `.transition` and `.themes` in one line.
- **`displayGroup`** exists because the four panchang limbs are four selectable
  items internally but should read as one source to the user. The debug endpoint
  shows the fine label; `sourcesUsed` shows the group.
- **`supersedes`** lets a derived fact declare that it makes a raw field redundant.

### `PersonalizationPlan`

The complete decision record for one request — intent, horizon, style, selected,
excluded, token accounting, reliability, constraints, notes.

One object drives the prompt, the logs *and* the debug endpoint. That unity is
why the explanation cannot drift from the behaviour.

---

## `config/intent-rules.config.ts` — behaviour as data

### The rule shape

```ts
export interface IntentRule {
  intent: Intent;
  description: string;
  categories: DomainCategory[];   // which derived facts to compute
  primary: string[];              // most relevant ids/patterns
  secondary: string[];            // useful supporting context
  exclude: string[];              // never sent for this intent
  horizonOverrides?: Partial<Record<Horizon, HorizonOverride>>;
}
```

A real entry:

```ts
career: {
  categories: ['career', 'finance', 'timing'],
  primary: ['derived.house.10', 'kundli.house.10', 'horoscope.career',
            'derived.dasha.position', 'derived.dasha.transition', 'derived.dasha.house_rulership'],
  secondary: ['derived.house.6', 'derived.house.11', 'kundli.lagna', 'horoscope.finance', …],
  exclude: ['horoscope.relationship', 'horoscope.health', 'kundli.house.7', 'derived.house.7'],
  horizonOverrides: {
    today:   { promote: ['panchang.*', 'derived.panchang.*'],
               demote:  ['derived.dasha.transition'],
               why: 'A single day is governed by the panchang; a multi-year dasha arc cannot resolve to one day.' },
    quarter: { drop: ['panchang.*', 'derived.panchang.*'],
               why: 'Panchang describes a single day and is actively misleading over a multi-month horizon.' },
  },
},
```

**`why` is not a comment — it is data.** The debug endpoint returns it verbatim,
so the explanation shown to a user and the rule driving behaviour are the same
string and cannot drift.

`Record<Intent, IntentRule>` makes the table exhaustive: adding an `Intent` fails
to compile until a rule exists.

### Pattern matching

```ts
export function matchesPattern(id: string, pattern: string): boolean {
  if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
  return id === pattern;
}
```

Deliberately not full glob — prefix-or-exact covers every case and has no
surprising behaviour.

**A real bug this caused:** `panchang.*` does **not** match
`derived.panchang.lord`, because the id starts with `derived.`. A derived panchang
fact survived a horizon that drops the panchang entirely. Fixed by listing both
patterns; caught by a test, not by reading.

### The constants

```ts
export const TIER_WEIGHTS = { primary: 100, secondary: 55, neutral: 15 } as const;
export const HORIZON_ADJUSTMENTS = { promote: 60, demote: -45 } as const;
export const CONFIDENCE_MULTIPLIER = { high: 1, medium: 0.85, low: 0.6 };
export const STALE_PENALTY = 0.75;
export const MIN_SCORE_THRESHOLD = 30;
```

The values are chosen so the tiers stay separated after adjustment:

- A promoted neutral item scores `15 + 60 = 75` — above secondary (55), below
  primary (100). Correct: for a "today" question the panchang should outrank
  supporting context but not the career house itself.
- A demoted secondary scores `55 − 45 = 10`, which falls **below the floor of
  30** and is excluded. Demotion at the secondary tier is effectively removal.
- The floor of 30 sits just above neutral (15), so background items are excluded
  on *relevance* even when budget remains.

---

## `intent/lexicon.ts`

```ts
export interface LexEntry {
  term: string;
  weights: Partial<Record<Intent, number>>;
}
```

`weights` is a map, not a single intent, so genuinely ambiguous terms contribute
to several:

```ts
{ term: 'salary', weights: { finance: 0.7, career: 0.6 } },
{ term: 'business', weights: { career: 0.7, finance: 0.4 } },
```

Forcing "salary" to be *either* career *or* finance would lose real information.

`PHRASES` are matched separately and weighted higher, because a collocation
carries more signal than its parts:

```ts
{ term: 'change my job', weights: { career: 2 } },
{ term: 'get married',   weights: { relationship: 2 } },
```

Devanagari entries sit alongside Latin ones — `नौकरी` (job), `शादी` (marriage) —
because Hindi input is normal traffic, not an edge case.

---

## `intent/intent.classifier.ts`

### Scoring

```ts
for (const entry of PHRASES) {
  if (q.includes(entry.term)) { applyWeights(scores, entry.weights); signals.push(entry.term); }
}

const lexHits = LEXICON.filter((entry) => containsTerm(q, entry.term));
const longestWins = lexHits.filter(
  (entry) => !lexHits.some((other) => other !== entry && other.term.includes(entry.term)),
);
for (const entry of longestWins) { applyWeights(scores, entry.weights); signals.push(entry.term); }
```

**The `longestWins` filter fixes a real bug.** `"investments"` matches both
`invest` and `investment`. Scoring both counts one piece of evidence twice and
skews the margin — which broke a secondary-intent test. The filter drops any
matched term that is a substring of another matched term.

Phrases are *not* deduplicated against lexicon terms, deliberately: the phrase
bonus is meant to stack on top of the component words.

### `containsTerm()` — the inflection problem

```ts
const INFLECTIONS = '(?:s|es|ed|d|ing|ment|ments|ance|al)?';

function containsTerm(haystack: string, term: string): boolean {
  if (!/^[\x20-\x7e]+$/.test(term)) return haystack.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}${INFLECTIONS}\\b`, 'i').test(haystack);
}
```

Three approaches, two of them wrong:

| Approach | `investments` | `investigation` |
|---|---|---|
| `\binvest` (prefix) | ✅ match | ❌ **false match** |
| `\binvest\b` (exact) | ❌ **miss** | ✅ no match |
| `\binvest(?:s\|ment\|ments\|ing)?\b` | ✅ match | ✅ no match |

The ASCII guard exists because Devanagari has no `\b` word boundaries — those
terms fall back to plain substring matching.

### Confidence calibration

```ts
const margin = (winner.score - second) / winner.score;
const strength = Math.min(1, 0.6 + (0.4 * winner.score) / STRONG_SIGNAL_SCORE);
const confidence = clamp((0.45 + 0.55 * margin) * strength, 0.35, 0.98);
```

Two components, because either alone misleads:

- **margin** — how far ahead the winner is. But a question matching one weak term
  with *no competitor* has a perfect margin of 1.0 and would report near-certainty.
- **strength** — how much evidence existed at all. `STRONG_SIGNAL_SCORE = 1.5`,
  roughly one strong phrase or two keywords.

```
"changing my job" → score 3.0, no competitor
   margin 1.0, strength 1.0 → 0.98

"meri shaadi kab hogi" → score 1.0, no competitor
   margin 1.0, strength 0.6 + 0.4×(1/1.5) = 0.87 → 0.87
```

Both are unambiguous, but the second rests on one word. Reporting 0.87 rather
than 0.98 is more honest — and it is what an LLM fallback would eventually gate on.

### The daily-intent override

```ts
let winner = top;
if (top.intent === 'daily' && runnerUp && runnerUp.score >= top.score * 0.6) {
  winner = runnerUp;
}
```

*"How does this week look for my relationship?"* scores on both `daily` ("this
week") and `relationship`. The **topic** should win; the temporal word is the
horizon extractor's job. Without this, every time-bounded question collapses into
`daily`.

---

## `intent/horizon.extractor.ts`

```ts
const RULES: { horizon: Horizon; patterns: RegExp[] }[] = [
  { horizon: 'lifetime', patterns: [/\b(ever|in\s+my\s+life(time)?|…)\b/i, …] },
  { horizon: 'quarter',  patterns: [/\bnext\s+(few|couple\s+of|2|3|…)\s+months?\b/i, …] },
  { horizon: 'year',     patterns: [/\b(this|next|coming)\s+year\b/i, …] },
  { horizon: 'month',    patterns: [/\b(this|next|coming)\s+month\b/i, …] },
  { horizon: 'week',     patterns: [/\b(this|next|coming)\s+week\b/i, …] },
  { horizon: 'today',    patterns: [/\b(today|tonight|right\s+now|…)\b/i, …] },
];

export function extractHorizon(question: string): { horizon: Horizon; signal?: string } {
  const q = question.normalize('NFKC');
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const m = re.exec(q);
      if (m) return { horizon: rule.horizon, signal: m[0].trim() };
    }
  }
  return { horizon: 'unspecified' };
}
```

**Order is the algorithm.** This is a first-match-wins scan, not scoring, and the
array is ordered most-specific-first.

`"in the next few months"` contains the substring `"month"`. If `month` were
checked first it would win and the question would be scoped to 30 days instead of
a quarter. Putting `quarter` above `month` prevents that.

`signal` returns the matched text so the debug endpoint can say *"horizon
'quarter' from the phrase 'next few months'"* — much more useful than the label
alone.

`normalize('NFKC')` canonicalises Unicode so visually identical Devanagari
sequences match consistently.

---

## `context-item.builder.ts`

Flattens four nested documents plus derived facts into one flat list.

```ts
build(bundle: ContextBundle, derived: DerivedFact[]): ContextItem[] {
  return [
    ...this.fromKundli(bundle),
    ...this.fromHoroscope(bundle),
    ...this.fromPanchang(bundle),
    ...this.fromDerived(derived),
  ];
}
```

**Why flatten?** Relevance is per-fact. The 10th house matters for a career
question; the 7th house in the *same document* does not. Keeping documents whole
forces an all-or-nothing choice.

### Stale panchang detection

```ts
const today = new Date().toISOString().slice(0, 10);
const isStaleDate = Boolean(p.date) && p.date !== today;
const confidence: ContextItem['confidence'] = isStaleDate ? 'low' : 'high';
const staleSuffix = isStaleDate ? ` (from ${p.date}, NOT today)` : '';
```

A panchang from a previous day is **worse than no panchang** — it looks
authoritative and is silently wrong. Marking it `low` confidence makes the scorer
down-rank it (×0.6) and the text itself carries the warning.

### `supersededBy()`

```ts
function supersededBy(derivedId: string): string[] {
  const houseMatch = /^derived\.house\.(\d+)$/.exec(derivedId);
  if (houseMatch) return [`kundli.house.${houseMatch[1]}`];

  switch (derivedId) {
    case 'derived.dasha.position':  return ['kundli.currentDasha'];
    case 'derived.moon.placement':
    case 'derived.moon.fallback':   return ['kundli.moonSign'];
    case 'derived.panchang.resonance': return ['panchang.nakshatra'];
    default: return [];
  }
}
```

A derived statement **strictly contains** the raw field it was computed from.
`derived.house.10` says everything `kundli.house.10` says, plus the sign and the
signification. Sending both pays twice for one fact.

### Label deduplication

```ts
text: `${h[m.key]} (today's reading)`,
```

The prompt renders `[id] Label: text`. An earlier version had
`text: "${m.label} for today: …"`, producing:

```
[horoscope.career] Career Horoscope: Career Horoscope for today: Networking may…
```

The label was paid for twice. Found by reading a real prompt dump, not by tests.

---

## `context.selector.ts` — the algorithm

Seven ordered steps. **Correctness filters run before scoring**, so the budget is
only spent on admissible candidates.

### Step 1 — reliability gate

```ts
let candidates = items;
if (!reliability.housesUsable) {
  const [kept, dropped] = partition(
    candidates,
    (i) => !/\.house\.\d+$/.test(i.id) && i.id !== 'kundli.lagna',
  );
  candidates = kept;
  // …record each dropped item with reason 'reliability'
}
```

The regex catches both `kundli.house.10` and `derived.house.10`. `kundli.lagna`
is excluded explicitly — the ascendant is exactly what an unreliable birth time
makes unknowable.

**Why remove rather than down-rank?** A budget surplus must never be able to let
an unsound statement back in. A test asserts this with a 100,000-token budget.

### Step 2 — redundancy

```ts
const presentIds = new Set(candidates.map((i) => i.id));
const superseded = new Map<string, string>();
for (const i of candidates) {
  for (const target of i.supersedes ?? []) {
    if (presentIds.has(target)) superseded.set(target, i.id);
  }
}
```

`presentIds.has(target)` matters: only supersede something that is actually
present. If the derived fact exists but the raw field was never built, nothing
happens.

The `Map` stores *which* item superseded it, so the exclusion detail can say
"Superseded by `derived.house.10`".

### Steps 3–4 — rule exclusions and horizon drops

Identical shape, different sources: `rule.exclude` and `override.drop`. Separate
reason codes (`rule:excluded` vs `rule:horizon-drop`) so the debug endpoint can
distinguish "never relevant to career" from "not meaningful over months".

### Step 5 — scoring

```ts
private score(item, ctx): ScoredItem {
  let tier: ScoredItem['tier'] = 'neutral';
  if (matchesAny(item.id, rule.primary))        { tier = 'primary';   reasons.push(…); }
  else if (matchesAny(item.id, rule.secondary)) { tier = 'secondary'; reasons.push(…); }

  if (tier === 'neutral') {
    for (const si of secondaryIntents) {
      if (matchesAny(item.id, INTENT_RULES[si].primary)) { tier = 'secondary'; break; }
    }
  }

  let score: number = TIER_WEIGHTS[tier];
  if (override?.promote && matchesAny(item.id, override.promote)) score += HORIZON_ADJUSTMENTS.promote;
  if (override?.demote  && matchesAny(item.id, override.demote))  score += HORIZON_ADJUSTMENTS.demote;

  score *= CONFIDENCE_MULTIPLIER[item.confidence];
  if (item.stale) score *= STALE_PENALTY;

  return { ...item, score: Math.max(0, round(score)), tier, reason: reasons.join('; ') };
}
```

Order matters: additive horizon adjustments first, then multiplicative quality
penalties. A promoted-but-stale item gets `(15 + 60) × 0.75`, not
`15 × 0.75 + 60`.

The secondary-intent lift only applies to items still `neutral` — an item already
primary for the main intent is not affected. And it runs **after** exclusions, so
a secondary intent can never resurrect an excluded item. Exclusions are absolute.

`reason` accumulates human-readable strings: *"primary source for career;
promoted for this time horizon"*. That string is what the debug endpoint shows.

### Step 6 — relevance floor

```ts
const relevant: ScoredItem[] = [];
for (const s of scored) {
  if (s.score >= MIN_SCORE_THRESHOLD) relevant.push(s);
  else excluded.push({ …, reason: 'rule:below-threshold',
                       detail: `Scored ${s.score}, below the relevance floor of ${MIN_SCORE_THRESHOLD}…` });
}
```

**The most important five lines in the file.** Without them, a generous premium
budget silently becomes "send everything that fits" — exactly the behaviour the
engine exists to prevent.

*Relevance decides what is admissible; the budget only decides how much of the
admissible set fits.*

### Step 7 — budget packing

```ts
relevant.sort((a, b) => b.score - a.score || a.tokens - b.tokens);

const selected: ScoredItem[] = [];
let tokensUsed = 0;
for (const candidate of relevant) {
  if (tokensUsed + candidate.tokens <= tokenBudget) {
    selected.push(candidate);
    tokensUsed += candidate.tokens;
  } else {
    excluded.push({ …, reason: 'budget' });
  }
}
```

The sort comparator: score descending, **then tokens ascending**. Among equally
relevant items the cheaper one goes first, so the budget stretches further.

The loop **does not `break`** on the first miss. A single expensive item that does
not fit must not block every cheaper item behind it. A test covers exactly this:
a 500-token item followed by two 5-token items under a 20-token budget selects
both small ones.

```ts
if (!selected.length && relevant.length) {
  const best = relevant[0];
  selected.push(best);
  tokensUsed = best.tokens;
  const idx = excluded.findIndex((e) => e.id === best.id && e.reason === 'budget');
  if (idx >= 0) excluded.splice(idx, 1);
  notes.push(`Budget of ${tokenBudget} tokens could not fit any item; forced the highest-ranked one…`);
}
```

The safety valve: an empty context produces an ungrounded answer, which is worse
than being over budget. The `splice` removes the now-incorrect budget exclusion.

---

## `style.resolver.ts`

```ts
resolve(user: UserProfile | undefined, intent: Intent, horizon: Horizon): ResponseStyle {
  const languageCode = this.resolveLanguage(user?.language);
  const tier = this.resolveTier(user?.subscription);
  return {
    languageCode, tier,
    language: LANGUAGE_NAMES[languageCode] ?? 'English',
    tone: this.resolveTone(user?.tonePreference),
    maxWords: this.resolveMaxWords(tier, intent, horizon),
    jargonLevel: TIER_JARGON[tier] ?? 'plain',
  };
}
```

`user` is `| undefined` — the User service may have failed. **Every axis degrades
independently**, so a missing profile yields English/neutral/free-tier rather
than an error.

```ts
private resolveLanguage(raw: string | undefined): string {
  if (!raw) return DEFAULT_LANGUAGE;
  const key = raw.trim().toLowerCase();
  if (LANGUAGE_NAMES[key]) return key;
  const base = key.split(/[-_]/)[0];        // "hi-IN" → "hi"
  return LANGUAGE_NAMES[base] ? base : DEFAULT_LANGUAGE;
}

private resolveMaxWords(tier: string, intent: Intent, horizon: Horizon): number {
  const base = TIER_BASE_WORDS[tier] ?? TIER_BASE_WORDS[DEFAULT_TIER];
  const scaled = base * HORIZON_LENGTH_FACTOR[horizon] * (INTENT_LENGTH_FACTOR[intent] ?? 1);
  return clamp(Math.round(scaled / 10) * 10, MIN_WORDS, MAX_WORDS);
}
```

Length is multiplicative across three axes, rounded to the nearest ten (a
"250-word" instruction is more natural than "247"), then clamped to 80–350.

```
premium(250) × quarter(1.0) × career(1.0) = 250
free(120)    × today(0.8)   × daily(0.7)  = 67 → clamped to 80
```

---

## `personalization.service.ts` — composing the engine

```ts
plan(input: PlanInput): PersonalizationPlan {
  const intentResult = trace.timeSync('intent.classify', () => this.classifier.classify(question));
  const { horizon, signal } = trace.timeSync('intent.horizon', () => extractHorizon(question));

  const rule = INTENT_RULES[intentResult.intent];

  const { facts, reliability } = trace.timeSync('astrology.infer', () =>
    this.inference.derive({ user: bundle.user.data, kundli: bundle.kundli.data,
                            panchang: bundle.panchang.data, categories: rule.categories }));

  const style = this.styleResolver.resolve(bundle.user.data, intentResult.intent, horizon);

  const items = this.itemBuilder.build(bundle, facts);
  const tokenBudget = style.tier === 'premium' ? cfg.CONTEXT_TOKEN_BUDGET_PREMIUM
                                               : cfg.CONTEXT_TOKEN_BUDGET_FREE;

  const selection = trace.timeSync('context.select', () =>
    this.selector.select({ items, intent: intentResult.intent,
                           secondaryIntents: intentResult.secondary,
                           horizon, tokenBudget, reliability }));

  return { …, notes: trace.getNotes() };
}
```

**Ordering is forced by data dependencies**, not preference:

1. Intent first — it selects the rule.
2. The rule supplies `categories`, which tells inference *which* facts to compute.
3. Inference must precede selection, because derived facts are themselves
   selectable items.
4. Style must precede selection, because the tier decides the token budget.

Note the method is **synchronous**. Everything here is pure computation — the only
I/O already happened in the fan-out. That is why the whole engine runs in under a
millisecond.
