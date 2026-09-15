# 6. Tech Stack Rationale

## The one number that settles most of it

```
llm.generate    9,880 ms   ← 99.4% of request time
everything else    61 ms
```

**The framework accounts for well under 1% of latency.** Any argument that picks
a stack for raw throughput is optimising the wrong thing by three orders of
magnitude. So the stack was chosen for **maintainability, testability and
reviewability** instead.

Keep this number in your pocket. It answers "why not Fastify?" in one line.

---

## Why NestJS, not Express or Fastify

### First, a fact that surprises people

**This *is* Express.** NestJS ships `@nestjs/platform-express` by default — it
runs on Express underneath. NestJS is not an alternative to Express; it is a
structural layer *on top of* it. Swapping to Fastify is a one-line adapter change
(`platform-fastify`), because the application code never touches the HTTP layer
directly.

So the real question is: *"why add structure on top of Express?"*

### The answer: the brief's rubric asks for exactly what a DI container provides

The assignment evaluates:

> "clean modular architecture" · "separation of concerns" · "swappable LLM
> provider" · "extensible Personalization Engine"

Those map one-to-one onto NestJS primitives:

| Requirement | NestJS primitive | What it looks like here |
|---|---|---|
| Swappable LLM provider | DI token + factory | `LLM_PROVIDER` symbol; provider chosen once in `llm.module.ts`; nothing downstream knows which is active |
| Separation of concerns | Modules + providers | `astrology/` is injectable and has zero framework imports |
| Clean boundaries | Constructor injection | Dependencies are explicit and visible in every signature |
| Request validation | `ValidationPipe` + `class-validator` | Declarative DTO; invalid input never reaches the pipeline |
| Testability | `Test.createTestingModule().overrideProvider()` | The e2e suite swaps `APP_CONFIG` cleanly without env hacking |

The swappable-provider requirement is the strongest argument. With plain Express
you would hand-roll a service locator or pass the provider through every
function. The DI container makes it a binding.

### Honest costs of NestJS

| Cost | Reality here |
|---|---|
| Heavier install | 627 packages vs ~60 for bare Express |
| Decorator magic | `@Injectable()`, `@Inject()` and `reflect-metadata` obscure control flow for newcomers |
| Boot overhead | ~200ms vs ~20ms — irrelevant for a long-running server |
| Arguably over-engineered | Three endpoints genuinely do not *need* a DI container |
| Real bugs it caused | DI resolution failures cost two debugging cycles during development (a constructor default treated as an injectable; a cross-module provider not exported) |

That last row is worth saying out loud in an interview. The framework had a real
cost, not just theoretical.

### Why not Fastify

- **Speed is irrelevant here** — see the number at the top. Fastify's 2–3×
  throughput advantage would optimise 0.6% of request time.
- Would need to hand-build DI, validation and module structure.
- Would be the right call for a high-QPS gateway with no LLM in the path.

### Why not bare Express

- No DI → the provider swap becomes manual wiring or a global.
- No structural convention → every reviewer has to learn *this* codebase's layout.
- Validation, config and error handling all hand-rolled.
- Would be the right call for a genuinely tiny service, or a team that already
  has strong conventions.

### The honest summary

> NestJS is not faster and it is not smaller. It was chosen because the
> assignment is explicitly graded on architecture and extensibility, and because
> a DI container turns "swappable LLM provider" from a design intention into a
> compile-checked binding. For a three-endpoint service it is arguably heavy —
> and it runs on Express anyway, so the HTTP layer costs nothing extra.

---

## Why TypeScript

**Chosen for:**

- The engine is fundamentally about **shapes of data** — `ContextItem`,
  `PersonalizationPlan`, `SourceResult<T>`. Types make the pipeline's contract
  self-documenting.
- `Record<Intent, IntentRule>` makes the config table *exhaustive by
  construction*: adding an `Intent` fails to compile until a rule exists for it.
  That is a real correctness property, not just tooling comfort.
- Discriminated unions model `outcome: 'ok' | 'cached' | 'stale' | 'failed'`
  precisely.
- Most common backend language in Indian consumer startups — likely to match the
  team.

**Cost:** a build step; `strict` mode occasionally fights you (generic inference
in test helpers needed explicit annotations).

**Why not Python/FastAPI:** it would be the better call if MyNaksh's AI stack is
Python — the ecosystem for evals and embeddings is stronger, and Pydantic is
comparable to zod. The domain layer (`src/astrology/`) is pure functions and
would port in about an hour. **This is a legitimate answer to "would you choose
differently?": yes, if the team is Python-first.**

**Why not Go:** the strongest concurrency story (`errgroup` for the fan-out reads
beautifully), but weakest LLM/eval tooling and least likely to match the team.

---

## Why zod for config, class-validator for HTTP

Two validation libraries looks like a smell. It is deliberate:

| | Library | Why |
|---|---|---|
| **Env config** | zod | Plain object validation at boot, outside the DI container. Coercion (`z.coerce.number()`) and a fail-fast parse with field-level errors. Not a class, so decorators don't apply. |
| **HTTP bodies** | class-validator | What NestJS's `ValidationPipe` integrates with natively. Decorator-based DTOs are the framework idiom. |

Using zod for HTTP would mean bypassing `ValidationPipe` and writing a custom
pipe — fighting the framework for uniformity's sake.

**Honest counter-argument:** one library is one less thing to learn, and `nestjs-zod`
exists. A reasonable reviewer could disagree here.

---

## Why no database

The brief's contract is stateless: `{userId, question}` in, answer out. No thread
id, so no conversation to persist. Adding Postgres would mean a schema, a
migration story and a container, in exchange for nothing the contract asks for.

**What we lose:** conversation memory, analytics on what users ask, and a
persistent cache. All recorded as production concerns.

---

## Why `fetch`, not axios

Node 18+ has `fetch` built in, with `AbortController` support — which is exactly
what the timeout implementation needs. Axios would add a dependency for
ergonomics we don't need.

**Cost:** slightly more verbose error handling (`fetch` doesn't reject on 4xx/5xx,
so `res.ok` must be checked explicitly).

---

## Why the Anthropic SDK but raw HTTP for OpenAI/OpenRouter

**Anthropic** gets the official SDK: typed errors (`AuthenticationError`,
`RateLimitError`), correct `cache_control` shapes, and a `countTokens` endpoint.

**OpenAI-compatible** providers get a ~70-line raw-HTTP adapter, because the
chat-completions shape is stable and *also* accepted by OpenRouter, Groq,
Cerebras, Together and most self-hosted gateways. One small adapter covers five
vendors; a second SDK would cover one.

**This paid off directly.** Adding OpenRouter required no new class — same
adapter, different base URL, two attribution headers. Nine lines.

---

## Dependency inventory

Ten runtime dependencies, all justified:

| Package | Why |
|---|---|
| `@nestjs/common`, `@nestjs/core`, `@nestjs/platform-express` | The framework |
| `reflect-metadata` | Required by NestJS decorators |
| `rxjs` | NestJS peer dependency (barely used directly) |
| `class-validator`, `class-transformer` | DTO validation |
| `zod` | Env config validation |
| `dotenv` | Load `.env` at boot |
| `@anthropic-ai/sdk` | Anthropic provider |

No lodash, no axios, no moment. The IST timezone arithmetic in `cache-policy.ts`
is ~10 lines of plain `Date` maths rather than a date library — worth knowing,
since a reviewer may ask why there's no `date-fns`.

---

## Deployment

Multi-stage Dockerfile: build with dev dependencies, `npm prune --omit=dev`, copy
`dist` + pruned `node_modules` into a clean `node:22-alpine`. Runs as the
non-root `node` user. Healthcheck hits `/health`.

Stateless, so any orchestrator can scale it horizontally with no coordination.
