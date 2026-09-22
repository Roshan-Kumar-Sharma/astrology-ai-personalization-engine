# 3. High-Level Design

## System context

```
┌──────────────┐
│  MyNaksh app │  (iOS / Android / web)
└──────┬───────┘
       │ POST /personalize   { userId, question }
       ▼
┌─────────────────────────────────────────────────────┐
│        PERSONALIZED AI CONTEXT ENGINE               │
│                                                     │
│   safety → gather → understand → infer → select     │
│          → prompt → generate → verify → score       │
└──────┬──────────────────────────────────┬───────────┘
       │ (concurrent, read-only)          │ (one call)
       ▼                                  ▼
┌──────────────────────────┐      ┌───────────────────┐
│  User · Kundli           │      │  LLM Provider     │
│  Horoscope · Panchang    │      │  Anthropic /      │
│  (existing services)     │      │  OpenRouter /     │
└──────────────────────────┘      │  OpenAI / Mock    │
                                  └───────────────────┘
```

**Stateless.** No database, no session store. Everything needed for a response
is fetched per request (with caching). This means horizontal scaling is trivial
and any instance can serve any request.

## Component responsibilities

| Component | Owns | Explicitly does *not* own |
|-----------|------|---------------------------|
| **api/** | HTTP contract, validation, stage sequencing | Any domain logic |
| **safety/** | Risk classification, refusals, output review | Astrology, selection |
| **upstream/** | Fetching, resilience, caching | Interpreting what it fetched |
| **astrology/** | Domain truth: dasha math, house lords, dignity, validation | I/O, framework, LLM |
| **personalization/** | Intent, horizon, item modelling, scoring, style | Astrology facts, HTTP |
| **llm/** | Provider abstraction, prompt assembly, token estimation | What goes in the prompt |
| **answer/** | Groundedness verification, confidence computation | Generation |
| **common/** | Config, logging, cache, resilience primitives | Anything domain-specific |

The boundary that matters most: **`astrology/` has zero framework and zero I/O
imports.** Every rule in it is a pure function. That is what makes the domain
independently testable and portable to another language if the stack changes.

## Data flow

```
question ──► Intent + Horizon ─┐
                               ├──► Selection Rules ──► ContextItem[] ──► Prompt ──► LLM
userId ──► 4 services ──► ContextBundle ──► Derived Facts ─┘                          │
                               │                                                      ▼
                               └──────────────► Confidence ◄──── Groundedness ◄─── Answer
```

Two inputs converge. The *question* determines what is relevant; the *userId*
determines what is available. Selection is the intersection.

## Key architectural properties

### 1. Deterministic core, probabilistic edge

The LLM sits at the very end and does one job: turn settled conclusions into
prose. Everything requiring correctness — intent, arithmetic, selection,
confidence, safety — is deterministic code with tests.

**Consequence:** ~99% of the pipeline is unit-testable without mocking a model,
and the same input always produces the same *plan* even if the prose varies.

### 2. Partial failure is normal, not exceptional

`UpstreamClient.fetch()` never throws. Every source resolves to a result
carrying its own outcome. There is no code path where one dead service produces
a 500.

Degradation ladder, verified under a 90% upstream failure rate:

| State | Behaviour |
|-------|-----------|
| All healthy | Full context, `HIGH` |
| Panchang down | Answer unchanged for non-daily questions, marginal confidence loss |
| Horoscope down | Chart-only answer, confidence down |
| Kundli down | Generic answer, capped at `MEDIUM` |
| Kundli + horoscope down | Capped at `LOW`, caps explain why |
| Everything down | Still `200`, `LOW`, honest answer, no crash |
| LLM down | Offline provider, `degraded: true`, confidence downgraded |

### 3. Behaviour lives in config, not code

`ContextSelector` contains no astrology and no per-intent branching. All
selection behaviour is data in `intent-rules.config.ts`; all safety behaviour is
data in `policies.config.ts`.

**Consequence:** adding an intent is a config entry. Adding a fifth upstream
service is a URL, a type and a mapper — the resilience stack is already generic.
Neither touches the pipeline.

### 4. The explanation is the implementation

`RequestTrace` accumulates timings and decisions, and powers *both* the logs and
the debug endpoint. `/debug/personalization` runs the same code path as
`/personalize`, minus generation.

**Consequence:** the explanation shown to a reviewer cannot drift from real
behaviour, because it *is* real behaviour.

## Scaling

**The bottleneck is the LLM, by three orders of magnitude** — 9.9s against 61ms
of engine work. Every scaling decision follows from that.

| Concern | Now | At scale |
|---------|-----|----------|
| Compute | Stateless, scale horizontally | Unchanged — no coordination needed |
| Cache | In-memory, per instance | **Redis**, same domain TTLs; hit rate currently degrades linearly with replica count |
| Circuit breaker | Per process | Shared state, or accept N independent learners |
| LLM cost | One call per non-blocked request | **Response cache** on the plan hash — identical `(user, question, day)` triples are common in this product |
| Rate limits | None | Per-user and per-IP budgets — mandatory before public exposure |
| Latency | ~10s | Streaming; the answer is generated whole today |

**The highest-leverage optimisation is not making the LLM faster — it is not
calling it.** The debug endpoint already demonstrates that a large class of
questions ("why did I get this answer?") can be served with zero generation.

## Failure modes and mitigations

| Failure | Detection | Mitigation |
|---------|-----------|------------|
| Upstream slow | Per-source timeout 1200ms | Abort, degrade, log |
| Upstream down | Circuit breaker after 5 failures | Skip the call, serve stale, protect latency budget |
| Upstream returns bad data | Chart validation against classical rules | Log inconsistency, cap confidence at 0.60 |
| Retry storm | — | Full-jitter backoff; every request fans out to five services at once |
| LLM down / rate-limited | Exception or 200-with-error body | Offline provider, `degraded`, confidence downgraded |
| LLM hallucinates | Groundedness verification | Flag, lower confidence, report honest `sourcesUsed` |
| LLM ignores output contract | `contractIgnored` flag | Fall back to raw text, penalise confidence 0.35 |
| LLM emits chain-of-thought | `<think>` stripping | Removed before the user sees it |
| Dangerous question | Policy table, pre-fetch | Blocked, reviewed response, no cost |
| Dangerous *answer* | Output rules | Replaced or softened |
| Birth time unusable | Reliability assessment | House context removed, Moon-sign fallback, cap at `MEDIUM` |

## Security posture

**Implemented:** input validation and length caps, question redaction in logs,
no secrets in the repo (`.env` gitignored, `.env.example` placeholders only),
non-root Docker user.

**Deliberately absent — see [Design Decisions](05-design-decisions.md):**
authentication, authorization and rate limiting. (Prompt-injection detection is
no longer on this list - it now lives in the guardrail layer as three policies.)
`userId` is trusted from the request body; in production it must come from a
verified session, or any caller can read any user's chart.

## What this design optimises for, and against

**For:** correctness, explainability, safe degradation, and cheap extension.

**Against:** raw throughput (irrelevant — the LLM dominates), and minimal line
count (the config tables and derived-fact layer are more code than a naive
implementation, and that is the trade being made deliberately).
