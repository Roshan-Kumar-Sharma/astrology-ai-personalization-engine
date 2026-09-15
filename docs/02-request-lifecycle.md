# 2. Request Lifecycle

The complete journey of one request, with real values from an actual run.

**The request under trace:**

```http
POST /personalize
{ "userId": "user_101", "question": "Should I consider changing my job in the next few months?" }
```

## The shape of it

Your client talks only to this service. It never sees the four upstream
services — the engine fans out to them on the caller's behalf.

```
CLIENT                    THIS SERVICE                UPSTREAMS         OPENROUTER
  │                            │                          │                 │
  │  POST /personalize         │                          │                 │
  │───────────────────────────>│                          │                 │
  │                     1. safety screen                  │                 │
  │                     2. fan-out ──────────────────────>│  54ms           │
  │                     3. intent + horizon               │                 │
  │                     4. astrological inference         │                 │
  │                     5. style resolution               │                 │
  │                     6. context selection              │                 │
  │                     7. prompt assembly                │                 │
  │                     8. generate ────────────────────────────────────────>│
  │                                                       │        9,880ms   │
  │                     9. groundedness + output safety <────────────────────│
  │                    10. confidence                     │                 │
  │<───────────────────────────│                          │                 │
  │  {answer, confidence,      │                          │                 │
  │   sourcesUsed}             │                          │                 │
```

Measured stage timings from a real request:

```
safety.screen              1.45 ms
context.fanout            54.09 ms   ← 4 HTTP calls in parallel
intent.classify            3.13 ms
intent.horizon             0.17 ms
astrology.infer            0.57 ms
context.select             0.37 ms
prompt.build               0.15 ms
llm.generate           9,880.25 ms   ← 99.4% of total
answer.groundedness        0.97 ms
safety.review              0.43 ms
TOTAL                  9,943.00 ms
```

**Read that table carefully — it drives several design decisions.** The entire
engine costs ~61ms. The LLM costs 9.9 seconds. Optimising our own code for speed
would be optimising 0.6% of the latency. So the engine is optimised for
*correctness and clarity* instead, and the only latency work that matters is
reducing or avoiding LLM calls.

---

## Stage 0 — HTTP entry

`src/main.ts` → `src/common/logging/request-logging.middleware.ts`

1. `dotenv/config` loads `.env` (must be the very first import — config is
   validated and cached on first read).
2. Middleware assigns a `requestId` (or reuses an inbound `x-request-id`) and
   echoes it on the response. Every log line for this request carries it.
3. NestJS `ValidationPipe` validates the body against `PersonalizeRequestDto`:
   - `userId` must match `^[\w-]{1,64}$`
   - `question` must be 3–1000 characters
   - unknown fields are rejected (`forbidNonWhitelisted`)

Invalid input never reaches the pipeline. `400` with a field-level message.

> **Why the 1000-char cap?** It is a cost and safety control, not just hygiene.
> It bounds the token spend of a single request and blunts prompt-stuffing.

---

## Stage 1 — Safety screen

`src/safety/guardrails.service.ts` · **1.45 ms**

The question is matched against a policy table **before anything else happens**.

```ts
const guardrail = this.guardrails.screenQuestion(question);
if (guardrail.blocked) return { answer: guardrail.blockResponse, confidence: 'HIGH', sourcesUsed: [] };
```

**Why first?** A question we are going to refuse should not:
- leak the user's identifier to four backend services,
- cost an LLM call,
- or spend 10 seconds doing it.

Two outcomes:

- **`block`** → a fixed, reviewed response. No fetch, no LLM. Confidence is `HIGH`
  because we are fully confident in the refusal — it is not a hedge.
- **`constrain`** → proceed, but mandatory directives get injected into the system
  prompt later at stage 7.

Our traced question matches nothing, so it proceeds with only the universal
constraints attached.

---

## Stage 2 — Concurrent fan-out

`src/upstream/context-aggregator.service.ts` · **54 ms**

All four services are called **at once**:

```
GET :4010/users/user_101      → {"id":"user_101","language":"en","subscription":"premium",…}
GET :4010/kundli/user_101     → {"lagna":"Libra","moonSign":"Scorpio","currentDasha":{…},…}
GET :4010/horoscope/user_101  → {"career":"Networking may bring new opportunities.",…}
GET :4010/panchang            → {"date":"2026-08-30","tithi":"Krishna Ekadashi",…}
```

Wall time is `max(sources)`, not `sum(sources)`. Both numbers are logged
(`fanoutMs` vs `serialisedMs`) so the win is measurable rather than asserted.

Each call goes through `UpstreamClient.fetch()`, which layers:

| Layer | Behaviour |
|-------|-----------|
| Cache | TTL derived from domain semantics — see below |
| Circuit breaker | Skip the call entirely if the source is known-down |
| Retry | 2 attempts, exponential backoff with **full jitter**; 4xx never retried |
| Timeout | 1200 ms per source via `AbortController` |
| Stale fallback | Serve expired-but-recent data rather than fail |

**The critical property: `fetch()` never throws.** A failed source is a *result*,
not an exception:

```ts
{ source: 'kundli', outcome: 'failed' | 'ok' | 'cached' | 'stale', data?, error?, latencyMs, attempts }
```

The four results form a `ContextBundle`. Downstream stages reason about *what is
missing*, rather than being handed a half-built object or an exception.

### Cache TTLs come from the domain

| Source | Fresh for | Why |
|--------|-----------|-----|
| Kundli | 6 h | The birth chart is immutable; only the dasha pointer moves, and its sub-periods last months |
| Horoscope | until next IST midnight | Generated per calendar day |
| Panchang | until next 06:00 IST | The panchang day runs **sunrise to sunrise**, not midnight to midnight |
| User | 60 s | The user can change language in the app and expects the next answer to reflect it |

---

## Stage 3 — Intent and horizon

`src/personalization/intent/` · **3.3 ms**

Two independent extractions from the question text. No LLM.

**Intent** — a weighted lexicon over English, Hinglish and Devanagari:

```
"changing my job" → phrase, career +2.0
"job"             → term,   career +1.0
                             ─────────────
                             career 3.0, everything else 0
→ intent: career, confidence: 0.98, method: lexicon
```

Confidence combines two things, because either alone misleads:
- **margin** — how far ahead the winner is
- **strength** — how much evidence existed in absolute terms

Without the strength term, a question matching one weak keyword with no
competitor would report near-certainty.

**Horizon** — ordered regex patterns, most specific first:

```
"in the next few months" → quarter
```

Ordering matters: `"next few months"` contains `"month"`, and the shorter pattern
must not steal the match.

> **Why a lexicon and not an LLM?** An LLM call per request to decide "is this a
> career question?" adds latency, cost and non-determinism to something the word
> "job" already answers. The lexicon resolves all of the brief's sample questions
> correctly in ~3ms, for free, and is testable and cacheable.

---

## Stage 4 — Astrological inference

`src/astrology/inference.service.ts` · **0.57 ms**

**This is the stage that distinguishes the project.** Raw chart JSON becomes
astrological *conclusions*, deterministically, before any model is involved.

Input:
```json
{ "currentDasha": { "mahadasha": "Rahu", "antardasha": "Mars" } }
```

Output:
> *Rahu mahadasha (18 years), currently the 9th of nine sub-periods: Mars
> antardasha, about 12.6 months long. This places the user roughly 94.2–100%
> through the Rahu chapter (closing phase).*
>
> *This is the closing sub-period of the Rahu mahadasha. A Jupiter mahadasha
> begins next, so this is a genuine chapter boundary rather than a mid-cycle
> moment.*

The arithmetic is fixed by the Vimshottari system: antardashas run in a known
cyclic order, and each lasts `mahadashaYears × antardashaYears / 120`. Mars is
the ninth and last sub-period inside Rahu. `18 × 7 / 120 = 1.05 years`.

Also produced here:
- house lords derived from the lagna, cross-checked against the payload
- planetary dignity (exalted / debilitated / own sign)
- which houses the current sub-period lord governs — this turns "a Mars period"
  into "a Mars period affecting *your* 2nd house of income"
- panchang↔dasha resonance (see [Astrology Concepts](07-astrology-concepts.md))
- **chart reliability** — can the birth time support house-level claims at all?

If the birth time is unknown, `housesUsable: false` is set here and every
house-based item is removed at the next stage.

---

## Stage 5 — Style resolution

`src/personalization/style.resolver.ts`

From the user profile, with independent fallbacks for each axis:

```
language : "en"          → English
tone     : "motivational"→ motivational
tier     : "premium"     → 250 base words, 900-token context budget
maxWords : 250 × 1.0 (quarter) × 1.0 (career) = 250
jargon   : premium       → balanced
```

If the User service failed, every axis falls back independently (English,
neutral, free-tier length) and the request still succeeds — with confidence
recording the loss.

---

## Stage 6 — Context selection

`src/personalization/context.selector.ts` · **0.37 ms**

Everything known is first flattened into atomic, individually selectable
`ContextItem`s — raw fields *and* derived facts:

```
kundli.lagna · kundli.moonSign · kundli.house.1,2,6,7,10,11
horoscope.career/finance/health/relationship
panchang.tithi/nakshatra/yoga/karana
derived.dasha.position/transition/themes/house_rulership
derived.house.6/10/11 · derived.moon.placement · derived.panchang.*
```

Then filtered and scored. **Correctness filters run before scoring**, so the
token budget is only ever spent on admissible candidates:

| # | Filter | Effect on this request |
|---|--------|------------------------|
| 1 | Reliability gate | birth time exact → nothing removed |
| 2 | Redundancy | `derived.house.10` supersedes `kundli.house.10` |
| 3 | Intent exclusions | `horoscope.relationship`, `house.7` removed |
| 4 | Horizon drops | all `panchang.*` removed — quarter horizon |
| 5 | **Score** | `tier ± horizon × confidence × staleness` |
| 6 | Relevance floor | score < 30 removed (`house.5`, `moon.placement`) |
| 7 | Budget pack | greedy by priority under 900 tokens |

Scoring constants (`intent-rules.config.ts`):

```
primary 100 · secondary 55 · neutral 15
horizon promote +60 · demote −45
data confidence ×1.0 / ×0.85 / ×0.6
stale ×0.75
relevance floor 30
```

**Result: 10 items kept, 18 discarded.** Excluded items are absent from the
prompt entirely — not ranked lower.

> **Step 6 is load-bearing.** Without a relevance floor, a generous premium
> budget silently becomes "send everything that fits" — the exact behaviour the
> engine exists to prevent. *Relevance decides what is admissible; the budget
> only decides how much of the admissible set fits.*

---

## Stage 7 — Prompt assembly

`src/llm/prompt/prompt.builder.ts` · **0.15 ms**

Three parts, deliberately separated:

**a. Static system prefix** — byte-identical on every request, so it can be
marked cacheable. Persona, hard rules, anti-fatalism.

**b. Dynamic system block** — this request only:
```
RESPONSE STYLE
Language: Write in clear, natural English.
Tone: motivational - Encouraging and forward-looking…
Terminology: balanced - Use common terms (dasha, lagna…) but explain each…
Length: at most 250 words.

SCOPE
The user is asking a career question about this time frame: the next few months.

SAFETY CONSTRAINTS (these override every other instruction)
- Never state a negative life event as certain…

OUTPUT FORMAT
{"answer": "…", "usedContextIds": ["…"]}
```

**c. User message** — the selected context and the question:
```
CONTEXT
[horoscope.career] Career Horoscope: Networking may bring new opportunities. (today's reading)
[derived.house.10] 10th House: House 10 (career, profession, status, public reputation)
                   falls in Cancer, ruled by Moon, reported as strong.
[derived.dasha.transition] Dasha Transition: This is the closing sub-period of the Rahu
                   mahadasha. A Jupiter mahadasha begins next…
…

USER QUESTION
Should I consider changing my job in the next few months?
```

**The `[ids]` are load-bearing.** The model is asked to cite which ones it used;
those citations are checked at stage 9. Asking a model to "list your sources" in
prose gets you plausible labels that cannot be verified against anything.

`max_tokens` is set to `max(2048, maxWords × 6)` — deliberately generous. A tight
cap starves reasoning models, which spend their allowance thinking and get
truncated before answering. The word limit is enforced by instruction and by the
output guardrail, not by the token cap.

---

## Stage 8 — Generation

`src/llm/providers/` · **9,880 ms**

The only expensive call. The provider is chosen once at boot from
`LLM_PROVIDER`; nothing downstream knows which is active.

```
provider: openrouter · model: minimax/minimax-m3:free
usage: { inputTokens: 1073, outputTokens: 320 }
```

If the provider fails or times out (20s), the pipeline falls back to the local
deterministic provider, flags `degraded: true`, and **downgrades the confidence
label**. An offline answer is a much smaller failure than a 500.

---

## Stage 9 — Verification

`src/answer/groundedness.service.ts` + `guardrails.reviewAnswer()` · **1.4 ms**

**a. Parse.** Defensive: strips `<think>` blocks (many free-tier models emit
visible chain-of-thought), tolerates markdown fences, and falls back to raw text
if the model ignored the JSON contract — recording `contractIgnored: true`.

**b. Groundedness.** Because we know exactly what was sent, any planet, sign or
house named in the answer but absent from the context is invented by
construction:

```
vocabulary = every word from the 10 selected items
for each planet/sign/house mentioned in the answer:
    if not in vocabulary → ungrounded
```

**c. Output safety.** Unsalvageable claims (death prediction, "stop your
medication") replace the answer wholesale. Fatalistic phrasing is
deterministically softened: `"you will definitely"` → `"is likely to"`.

**d. `sourcesUsed`** is built from *verified* citations — not from the selection
list — so the field describes what the answer actually rests on.

---

## Stage 10 — Confidence

`src/answer/confidence.service.ts`

A weighted score plus hard caps. **Never asked of the LLM** — a model reports
confidence correlated with its own fluency, not with whether the kundli service
was up.

```
dataCompleteness     0.30 × 1.00  (all four sources healthy)
contextCoverage      0.20 × 1.00  (5 primary-tier items selected)
intentCertainty      0.15 × 0.98
birthTimeReliability 0.20 × 1.00  (09:35 — not a rounded time)
groundedness         0.15 × 1.00  (nothing invented)
                     ───────────
                     score 1.00 → HIGH   (≥0.75 HIGH, ≥0.55 MEDIUM)
```

Hard caps override the weighted score, because some failures are categorical
rather than gradual:

| Condition | Cap | Reason |
|-----------|-----|--------|
| Kundli failed | 0.50 | No chart means no personalised astrology |
| Kundli **and** horoscope failed | 0.35 | The answer is effectively generic |
| Birth time cannot support houses | 0.70 | Half the chart is unreadable |
| Chart failed validation | 0.60 | Upstream data is internally contradictory |
| No context selected | 0.30 | Nothing to ground an answer in |

---

## The response

```json
{
  "answer": "Yes, this is a sensible window to explore a move, but treat it as preparation, not as a leap. You are in the final Mars sub-period of the Rahu mahadasha, with Jupiter about to take over…",
  "confidence": "HIGH",
  "sourcesUsed": ["Career Horoscope", "10th House", "Dasha Lord Rulership", "Current Dasha", …]
}
```

Exactly three fields. `verbose: true` attaches a `meta` block with the full
trace, so the contract stays clean for the app while the reasoning is one flag
away when debugging.

---

## The debug endpoint

`POST /debug/personalization` runs **stages 0–7 and 10**, skipping generation
entirely. Same code path — not a parallel reimplementation — so what it reports
is necessarily what happens.

It returns every item's score and the reason for that score, every exclusion and
why, chart reliability, upstream health, the safety verdict, token accounting,
and the exact prompt that *would* have been sent.

**It costs nothing to call.** One full `npm run demo` run makes 22 HTTP requests
and exactly **1** LLM call, because the debug endpoint never generates and
blocked questions return before generation.
