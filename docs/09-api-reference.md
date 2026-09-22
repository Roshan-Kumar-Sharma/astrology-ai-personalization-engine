# 9. API Reference

Base URL: `http://localhost:3000`

---

## `POST /personalize`

Generate a personalised astrological answer.

### Request

```json
{
  "userId": "user_101",
  "question": "Should I consider changing my job in the next few months?",
  "verbose": false
}
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `userId` | string | yes | `^[\w-]{1,64}$` |
| `question` | string | yes | 3–1000 chars |
| `verbose` | boolean | no | Attaches the full engine trace as `meta` |

Unknown fields are rejected with `400`.

Optional header: `x-request-id` — reused for tracing and echoed on the response.

### Response `200`

```json
{
  "answer": "Yes, this is a sensible window to explore a move, but treat it as preparation, not as a leap. You are in the final Mars sub-period of the Rahu mahadasha, with Jupiter about to take over…",
  "confidence": "HIGH",
  "sourcesUsed": ["Career Horoscope", "10th House", "Dasha Lord Rulership", "Current Dasha"]
}
```

| Field | Meaning |
|---|---|
| `answer` | The generated text, in the user's language and tone |
| `confidence` | `HIGH` / `MEDIUM` / `LOW` — computed, not model-reported |
| `sourcesUsed` | Verified context the answer actually rests on |

**Exactly three fields.** No other keys appear unless `verbose` is set.

### Confidence semantics

| Label | Score | Means |
|---|---|---|
| `HIGH` | ≥ 0.75 | All key sources present, birth time reliable, answer grounded |
| `MEDIUM` | ≥ 0.55 | Something degraded — a source failed, birth time approximate/unknown, or grounding imperfect |
| `LOW` | < 0.55 | Chart unavailable or answer effectively generic |

### `verbose: true`

Adds `meta` with the full decision record:

```jsonc
{
  "answer": "…", "confidence": "HIGH", "sourcesUsed": [...],
  "meta": {
    "requestId": "bc5b13df-…",
    "intent": "career",
    "horizon": "quarter",
    "style": { "language": "English", "tone": "motivational", "maxWords": 250, "jargonLevel": "balanced", "tier": "premium" },
    "confidence": { "label": "HIGH", "score": 1, "factors": [ … ], "caps": [] },
    "groundedness": { "verifiedIds": [...], "fabricatedIds": [], "ungroundedEntities": [], "contractIgnored": false, "score": 1 },
    "safety": { "policies": [], "escalateToHuman": false },
    "tokens": { "contextSelected": 330, "contextAvailable": 606, "naiveRawJsonDumpTokens": 230, "total": 1057 },
    "llm": { "provider": "openrouter", "model": "minimax/minimax-m3:free", "usage": {...}, "degraded": false },
    "latency": { "totalMs": 9943, "spans": [ { "name": "llm.generate", "ms": 9880.25 }, … ] }
  }
}
```

### Blocked questions

Safety-blocked questions still return `200` with a reviewed response:

```json
{
  "answer": "I don't make predictions about death or lifespan — no responsible astrologer does…",
  "confidence": "HIGH",
  "sourcesUsed": []
}
```

`confidence` is `HIGH` because we are fully confident in the refusal; it is not a
hedge. `sourcesUsed` is empty because no chart data was used. With `verbose`,
`meta.blocked` and `meta.policies` explain which policy fired.

### Errors

| Status | Cause |
|---|---|
| `400` | Validation failure — field-level message in the body |
| `200` | **Everything else.** Upstream failures degrade; they do not error |

There is no code path where a dead upstream service produces a `5xx`. Verified
under a 90% injected failure rate.

---

## `POST /debug/personalization`

Run the entire engine **except generation**, and explain the reasoning.

Same request shape. **Never calls the LLM — free to invoke.**

> Served only while `DEBUG_ENDPOINTS_ENABLED` is true (the default). Set it to
> false and this endpoint *and* the console below return `404` — not `403`, which
> would confirm they exist. Neither carries authentication of its own, so in a
> real deployment they belong behind the same auth or network policy.

### Response `200`

The shape the brief specifies, plus an `explain` block:

```json
{
  "intent": "career",
  "selectedContext": ["Career Horoscope", "10th House", "Current Dasha", "…"],
  "excludedContext": ["Relationship Horoscope", "7th House", "Health Horoscope", "…"],
  "language": "English",
  "tone": "Motivational",

  "explain": {
    "intentDetection": { "intent": "career", "confidence": 0.98, "method": "lexicon", "secondaryIntents": [], "rule": "Work, job change, promotion…" },
    "timeHorizon": { "horizon": "quarter", "effect": "Panchang describes a single day and is actively misleading over a multi-month horizon." },
    "focus": [],
    "responseStyle": { … },
    "chartReliability": { "birthTime": "exact", "housesUsable": true, "inconsistencies": [], "notes": [] },
    "selected": [ { "id": "derived.house.10", "label": "10th House", "tier": "primary", "score": 100, "tokens": 24, "why": "primary source for career", "text": "House 10 (career…) falls in Cancer…" } ],
    "excluded": [ { "id": "horoscope.relationship", "label": "Relationship Horoscope", "reason": "rule:excluded", "detail": "Not relevant to a career question; excluded by rule." } ],
    "tokenBudget": { "budget": 900, "contextTokensUsed": 330, "contextTokensAvailable": 606, "naiveRawJsonDumpTokens": 230, "savedPct": 46, "promptTokens": { … } },
    "safety": { "blocked": false, "policies": [], "injectedConstraints": [ … ], "escalateToHuman": false },
    "upstream": { "kundli": { "outcome": "ok", "latencyMs": 41, "attempts": 1 }, "transit": { … }, … },
    "projectedConfidence": { "label": "HIGH", "score": 1, "factors": [ … ], "caps": [] },
    "notes": [ "Intent \"career\" (lexicon, confidence 0.98) from: job, changing my job", … ],
    "latency": { … },
    "promptPreview": "…the exact prompt that would have been sent…"
  }
}
```

### `focus`

The planets the question names outright — `["Saturn"]` for *"Is my Sade Sati
over?"*, `[]` for most questions. Read by a third deterministic extractor
alongside intent and horizon; each named planet's transit facts are promoted in
selection, and the ledger says so (`promoted: the question names Saturn`).
Naming a planet never changes the intent.

### Exclusion reasons

| Reason | Meaning |
|---|---|
| `rule:excluded` | Not relevant to this intent — excluded by rule |
| `rule:horizon-drop` | Meaningless over this time horizon |
| `rule:below-threshold` | Scored below the relevance floor (30) |
| `budget` | Relevant but did not fit the token budget |
| `reliability` | Birth time cannot support house-level claims |
| `unavailable` | Superseded by a derived fact, or the source failed |

### Why this endpoint exists

It runs the **same code path** as `/personalize`, minus generation — not a
parallel reimplementation. What it reports is necessarily what happens.

This is the endpoint to reach for during an incident, and the one to demo in an
interview.

---

## `GET /console`

The HTML debug console: one self-contained page that drives
`POST /debug/personalization` and renders it. No build step, no framework, no
CDN — it works offline and inside a locked-down container.

```bash
npm start   # then open http://localhost:3000/console
```

It shows, for one question:

| Panel | What it answers |
|---|---|
| Verdict | Intent (and how it was reached), horizon, style, projected confidence, safety state, prompt size |
| vs previous run | What changed since the last run — including items that stayed excluded **for a different reason** |
| Safety | The policy that fired, its rationale, and the constraints injected into the prompt |
| Context ledger | Every selected fact with score, tokens and reason; every excluded fact grouped by *why* |
| Token accounting | Context sent vs all candidates vs a naive raw-JSON dump vs the budget ceiling |
| Confidence | Each factor's weight, value and contribution, plus any hard caps |
| Upstream & latency | Per-source outcome, latency and attempts; per-stage timings |
| The exact prompt | The text the model would have received, copyable |
| Raw payload | The response the whole page was rendered from |

Deep-linkable: `?user=user_103&q=What%20should%20I%20focus%20on%20for%20my%20health%3F`
runs that case on load, which makes a specific decision shareable.

**Generation is opt-in.** The default action costs nothing; the *also write the
answer* checkbox additionally calls `POST /personalize` and is labelled as
spending tokens. When the configured provider fails and the service degrades to
the local fallback, the console says so in a banner above the answer — the prose
alone is not evidence of a live model.

### `GET /console/bootstrap`

What the page needs to describe the *running* service: the bundled fixture user
ids, the configured LLM provider and model, the feature-flag states, the context
budgets, and the preset list. Read-only, and returns nothing the rest of the
debug surface does not already expose.

---

## `GET /health`

```json
{ "status": "ok", "uptimeSeconds": 412, "cache": { "hits": 63, "staleHits": 0, "misses": 16, "size": 10 } }
```

---

## Mock upstream services

When `MOCK_UPSTREAM_ENABLED=true` (default), these are served on port `4010`:

| Endpoint | Returns |
|---|---|
| `GET /users/:userId` | User profile |
| `GET /kundli/:userId` | Birth chart |
| `GET /horoscope/:userId` | Daily horoscope (`?date=` optional) |
| `GET /panchang` | Daily almanac (`?date=` optional) |
| `GET /transits` | Sidereal positions of Saturn, Jupiter, Rahu and Ketu (`?date=` optional; propagated by mean motion, not an ephemeris) |
| `GET /health` | Liveness |

Any endpoint accepts `?fail=1` to force a `503`, for scripted degradation demos.

### Test users

| User | Language | Tier | Tone | Birth time | Exercises |
|---|---|---|---|---|---|
| `user_101` | en | premium | motivational | exact (09:35) | Full-confidence path |
| `user_102` | hi | free | gentle | approximate (18:30) | Devanagari output, reduced budget |
| `user_103` | hinglish | free | analytical | **unknown** | House suppression, Moon-sign fallback, `MEDIUM` cap |
| `user_104` | mr | premium | direct | exact (04:22) | A fourth language, and an early-phase dasha |

Every chart is astrologically self-consistent — house lords match what the stated
lagna actually produces.

---

## Curl cookbook

```bash
# The brief's example
curl -s -X POST localhost:3000/personalize -H 'content-type: application/json' \
  -d '{"userId":"user_101","question":"Should I consider changing my job in the next few months?"}'
```

```bash
# See the engine's reasoning — no LLM call, no cost
curl -s -X POST localhost:3000/debug/personalization -H 'content-type: application/json' \
  -d '{"userId":"user_101","question":"Should I consider changing my job in the next few months?"}' | python3 -m json.tool
```

```bash
# Horizon changes selection: same question, different time frame
curl -s -X POST localhost:3000/debug/personalization -H 'content-type: application/json' \
  -d '{"userId":"user_101","question":"How is my job today?"}'
```

```bash
# Safety: blocked, no LLM call
curl -s -X POST localhost:3000/personalize -H 'content-type: application/json' \
  -d '{"userId":"user_101","question":"When will I die?"}'
```

```bash
# Degradation: 90% upstream failure, still 200
MOCK_UPSTREAM_FAULT_RATE=0.9 npm start
```
