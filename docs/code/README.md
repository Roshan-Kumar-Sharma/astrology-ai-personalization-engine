# Code Walkthrough

A guided read of **every file and every function**, in the order that makes them
easiest to understand.

## How to read a codebase (and why this order)

Do **not** start at `main.ts`. Entry points are the most connected files — you
hit ten unfamiliar names in the first twenty lines and stall.

Start at the **leaves**: files that import nothing from the project. They can be
understood completely on their own. Then move up, and by the time you reach the
pipeline every name is already familiar.

```
        api/           ← read LAST (depends on everything)
         ↑
    personalization/ · safety/ · answer/ · llm/
         ↑
    astrology/ · upstream/
         ↑
       common/         ← read FIRST (depends on nothing)
```

## Reading order

| # | File | What it covers | Files |
|---|------|----------------|-------|
| 1 | [Foundations](01-foundations.md) | Config, logging, tracing, cache, retry, circuit breaker | `common/` |
| 2 | [Upstream](02-upstream.md) | Types, cache policy, the resilient client, fan-out, mock services | `upstream/` |
| 3 | [Astrology](03-astrology.md) | Zodiac tables, dasha maths, validation, inference | `astrology/` |
| 4 | [The Engine](04-engine.md) | Lexicon, intent, horizon, item building, selection, style | `personalization/` |
| 5 | [Safety & LLM](05-safety-llm.md) | Policies, guardrails, tokenizer, prompt builder, providers | `safety/`, `llm/` |
| 6 | [Answer & API](06-answer-api.md) | Groundedness, confidence, the pipeline, controllers, bootstrap | `answer/`, `api/`, `main.ts` |
| 7 | [Adding a User](07-adding-a-user.md) | Where user data comes from, and how to add or change one | `upstream/mock/` |

## Conventions used throughout the code

Recognising these five patterns makes most of the codebase predictable.

**1. Failure is a value, not an exception.**
`UpstreamClient.fetch()` never throws. It returns `{ outcome: 'ok' | 'failed' | … }`.
Callers branch on data instead of wrapping in try/catch.

**2. Config objects are exported constants, not magic numbers.**
`TIER_WEIGHTS`, `RISK_POLICIES`, `INTENT_RULES` live in `*.config.ts` files. If
you want to change behaviour, look there first.

**3. Pure functions live outside classes.**
Anything not needing dependency injection is a plain exported function at the
bottom of the file (`partition`, `round`, `ordinal`). Classes are reserved for
things NestJS must inject.

**4. Types are the documentation.**
`ContextItem`, `PersonalizationPlan`, `SourceResult<T>` describe the whole data
flow. Read `types.ts` in a folder before reading its logic.

**5. Comments explain *why*, never *what*.**
`i++ // increment i` does not appear. Where a comment exists, it is because a
reader would reasonably ask "why is it done this odd way?"

## Two habits that will save you

**Follow one value.** Pick `question` and trace it: DTO → guardrails → classifier
→ horizon extractor → prompt builder → LLM. You will cross six files and
understand how they connect better than reading each in isolation.

**Run the debug endpoint next to the code.** Every stage in the walkthrough shows
up in that JSON, so you can see the output of the exact function you're reading.

```bash
curl -s -X POST localhost:3000/debug/personalization \
  -H 'content-type: application/json' \
  -d '{"userId":"user_101","question":"Should I change my job this year?"}' | python3 -m json.tool
```
