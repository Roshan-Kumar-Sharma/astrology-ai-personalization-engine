# Project Handbook

Everything about this codebase, written so that someone who has never seen it —
and who knows nothing about Vedic astrology — can understand it fully.

Read in order if you are new. Jump around if you are not.

| # | Document | What it answers |
|---|----------|-----------------|
| 1 | [Overview](01-overview.md) | What is this, what problem does it solve, what is the mental model? |
| 2 | [Request Lifecycle](02-request-lifecycle.md) | What happens, in order, when a request arrives? Where does the data come from and go? |
| 3 | [High-Level Design](03-hld.md) | System shape, components, boundaries, scaling, failure modes. |
| 4 | [Low-Level Design](04-lld.md) | Every module, class, and data structure, with signatures. |
| 5 | [Design Decisions](05-design-decisions.md) | Each decision, the alternatives rejected, and the honest cost of choosing. |
| 6 | [Tech Stack Rationale](06-tech-stack.md) | Why NestJS and not Express/Fastify. Why TypeScript. Why no database. |
| 7 | [Astrology Concepts](07-astrology-concepts.md) | The domain, from zero. What we model, and what we deliberately do not. |
| 8 | [AI & LLM Concepts](08-ai-concepts.md) | Grounding, token budgets, prompt design, intent classification, why not RAG. |
| 9 | [API Reference](09-api-reference.md) | Endpoints, contracts, examples, error behaviour. |
| 10 | [Interview Guide](10-interview-guide.md) | The questions you will be asked, including the ones designed to find cracks. |
| 11 | [Evaluation & Safety](11-evaluation-and-safety.md) | How the eval and the safety hardening work — concepts, issues hit, and **experiments to run**. |
| — | [Architecture Diagrams](architecture.md) | Mermaid diagrams: pipeline, layers, per-item decision flow. |

### Reading the source itself

| Guide | Covers |
|-------|--------|
| **[Code Walkthrough](code/README.md)** | **Every file, every function, line by line — in dependency order** |
| [1. Foundations](code/01-foundations.md) | `common/` — config, logging, tracing, cache, retry, circuit breaker |
| [2. Upstream](code/02-upstream.md) | `upstream/` — types, cache policy, resilient client, fan-out, mocks |
| [3. Astrology](code/03-astrology.md) | `astrology/` — zodiac tables, dasha maths, validation, inference |
| [4. The Engine](code/04-engine.md) | `personalization/` — lexicon, intent, horizon, selection, style |
| [5. Safety & LLM](code/05-safety-llm.md) | `safety/`, `llm/` — policies, guardrails, tokenizer, prompt, providers |
| [6. Answer & API](code/06-answer-api.md) | `answer/`, `api/`, `main.ts` — grounding, confidence, pipeline, bootstrap |
| [7. Adding a User](code/07-adding-a-user.md) | Where user data comes from; adding a new test user end to end |

## The 60-second version

A user asks a free-text question. Four backend services hold their astrological
data. An LLM writes the answer. **This service is the layer in between** — it
decides what the question is really asking, what subset of the user's data is
relevant, what the data *means*, how the answer should sound, and whether the
answer that came back can be trusted.

The core claim is that this layer should be **mostly deterministic**. The LLM
writes prose; everything else — intent, selection, astrological inference,
confidence, safety — is computed by code that can be unit-tested.

## The five ideas worth remembering

1. **Time horizon is a selection axis.** "Today" and "the next few months" need
   different data from the same chart.
2. **Derive conclusions before the model sees anything.** Compute what the chart
   *means*; don't ask the LLM to do arithmetic it will hallucinate.
3. **Confidence is computed, never asked of the model.**
4. **Verify the answer against what was actually sent.**
5. **Safety is a pipeline stage, not a sentence in a prompt.**

## Fast orientation for a code reader

```
src/astrology/      ← start here. Pure functions, no I/O, the domain truth.
src/personalization/← the engine. Config decides behaviour; the selector just applies it.
src/api/personalize.service.ts ← the 10-stage pipeline, readable top to bottom.
```
