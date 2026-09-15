# 5. Safety & LLM — `src/safety/`, `src/llm/`

---

## `safety/policies.config.ts`

### The policy shape

```ts
export interface RiskPolicy {
  id: string;
  action: 'block' | 'constrain';
  patterns: RegExp[];        // any one match fires
  allOf?: RegExp[][];        // every group must match
  rationale: string;
  blockResponse?: string;    // for 'block'
  constraints?: string[];    // for 'constrain'
  escalateToHuman?: boolean;
  priority: number;
}
```

Policy is **data**, not code, because it changes with legal advice and app-store
review — and that should never require touching the pipeline.

### Two matching modes, and why the second exists

```ts
patterns: [
  /\b(do|does)\s+(i|he|she|they)\s+have\s+(cancer|a\s+tumou?r|…)\b/i,
  /\bshould\s+i\s+(stop|skip|avoid|delay)\s+(taking\s+)?(my\s+)?(medicine|medication|…)\b/i,
],
allOf: [
  [/\b(cancer|tumou?r|diabet\w*|hiv|stroke|…|surgery|operation|chemo\w*)\b/i],
  [/\b(cure[ds]?|curable|heal(ed|ing)?|recover(y|ed|ing)?|surviv\w+|get\s+better|…)\b/i],
],
```

`patterns` is OR — good for distinctive phrasings like *"when will I die"*.

`allOf` is AND-of-ORs — read as `[subjects] AND [verbs]`.

**Why `allOf` had to exist.** The original medical policy was one regex, and
`"Will my mother's cancer be cured?"` slipped straight through. The pattern
expected `will [disease] be [verb]`, but the possessive `mother's` sat between
them and `\w*` does not match an apostrophe.

Trying to write one regex covering every word order, possessive and filler word
is a losing game — and it fails silently on the first phrasing you did not
anticipate. Splitting the *concepts* ("a disease is mentioned" AND "a prognosis is
being asked about") is both more robust and far easier to review.

This was the single highest-risk bug found during development.

### Priority

```ts
priority: 100,  // crisis_self_harm
priority: 95,   // prenatal_sex_determination
priority: 90,   // death_timing
priority: 85,   // medical_prognosis
priority: 80,   // harm_to_others
priority: 60,   // specific_financial_advice   (constrain)
```

Policies are sorted descending, so when several match, the most serious wins.
*"I want to kill myself, will my cancer be cured?"* matches both crisis and
medical — crisis must win, and a test asserts exactly that.

### The crisis response

```ts
const CRISIS_RESPONSE = [
  "I'm really glad you reached out, and I want to respond to what you've said rather than to your chart.",
  '',
  '• **Tele-MANAS** (Government of India, 24x7, multiple languages): **14416** …',
  '• **KIRAN** mental health helpline (24x7): **1800-599-0019**',
  '• **AASRA** (24x7): **+91 98204 66726**',
  // …
].join('\n');
```

Deliberately does not moralise, does not predict, and **does not use the chart**.
Indian helplines first because that is the primary market, with a line covering
users elsewhere. A test asserts the response contains no astrological language.

### Universal constraints

```ts
export const UNIVERSAL_CONSTRAINTS: string[] = [
  'Never state a negative life event as certain. Describe tendencies, timing and climate, never verdicts.',
  "Preserve the user's agency: the chart describes conditions, the user makes the decision.",
  'Do not diagnose medical conditions, predict death, or guarantee financial or legal outcomes.',
  'Only use the astrological context supplied below. If the context does not support a claim, do not make it.',
];
```

Applied to **every** request. The anti-fatalism rule is a product decision as much
as a safety one — *"you will lose your job in October"* is how an astrology app
gets uninstalled and screenshotted, and it is also bad astrology, since a dasha
describes a climate rather than a verdict.

---

## `safety/guardrails.service.ts`

### `screenQuestion()`

```ts
screenQuestion(question: string): GuardrailDecision {
  const normalized = normalize(question);
  const matched = this.policies.filter((p) => matchesPolicy(p, normalized));

  const blocking = matched.find((p) => p.action === 'block');
  if (blocking) {
    return { blocked: true, matchedPolicies: [blocking.id], rationale: [blocking.rationale],
             constraints: [], blockResponse: blocking.blockResponse,
             escalateToHuman: blocking.escalateToHuman ?? false };
  }

  const constraining = matched.filter((p) => p.action === 'constrain');
  return { blocked: false, matchedPolicies: constraining.map((p) => p.id), …,
           constraints: [...UNIVERSAL_CONSTRAINTS, ...constraining.flatMap((p) => p.constraints ?? [])] };
}
```

`this.policies` is pre-sorted by priority, so `.find()` returns the **most
serious** blocking policy.

Blocking short-circuits; constraining accumulates — several constrain policies
can apply at once, and their directives concatenate onto the universal set.

```ts
function matchesPolicy(policy: RiskPolicy, question: string): boolean {
  if (policy.patterns.some((re) => re.test(question))) return true;
  if (!policy.allOf?.length) return false;
  return policy.allOf.every((group) => group.some((re) => re.test(question)));
}
```

`every(group => group.some(re => ...))` is the AND-of-ORs: every group needs at
least one hit.

### The DI gotcha

```ts
private policies: RiskPolicy[] = sortByPriority(RISK_POLICIES);

static withPolicies(policies: RiskPolicy[]): GuardrailsService {
  const svc = new GuardrailsService();
  svc.policies = sortByPriority(policies);
  return svc;
}
```

The original was `constructor(policies: RiskPolicy[] = RISK_POLICIES)`. It looked
clean and **broke NestJS at boot**: Nest resolves constructor parameters by type
and tried to inject an `Array`, which is not a registered provider.

A default parameter value is invisible to the DI container. Hence a no-arg
constructor plus a static factory for tests.

### `reviewAnswer()` — the output guard

```ts
reviewAnswer(answer: string): OutputReview {
  const violations: string[] = [];
  for (const rule of HARD_OUTPUT_RULES) {
    if (rule.pattern.test(answer)) violations.push(rule.id);
  }
  if (violations.length) {
    return { answer: "I'm not able to give a reliable answer to this one…", violations, replaced: true };
  }

  let softened = answer;
  const soft: string[] = [];
  for (const rule of SOFTENING_RULES) {
    if (rule.pattern.test(softened)) {
      softened = softened.replace(rule.pattern, rule.replacement);
      soft.push(rule.id);
    }
  }
  return { answer: softened, violations: soft, replaced: false };
}
```

Two severities:

```ts
const HARD_OUTPUT_RULES = [
  { id: 'output.death_prediction', pattern: /\byou\s+will\s+die\b|…/i },
  { id: 'output.stop_treatment',   pattern: /\b(stop|discontinue|avoid)\s+…(medication|treatment|chemo\w*)\b/i },
];

const SOFTENING_RULES = [
  { id: 'soft.will_definitely', pattern: /\bwill\s+definitely\b/gi, replacement: 'is likely to' },
  { id: 'soft.you_will_lose',   pattern: /\byou\s+will\s+lose\b/gi, replacement: 'there is a risk of losing' },
];
```

**Hard** = unsalvageable, replace the whole answer. **Soft** = the claim is fine,
the certainty is not — rewrite in place.

Deterministic rewriting beats a second LLM call: cheaper, faster, and it makes
the rule *enforced* rather than *requested*. A second model pass to "make this
safer" is itself probabilistic.

> **Known gap:** every output rule is English-only. A Hindi answer making the same
> claim would pass. Documented in the interview guide as a real weakness.

---

## `llm/tokenizer.ts`

```ts
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let ascii = 0, indic = 0, otherNonAscii = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code < 128) ascii += 1;
    else if (code >= 0x0900 && code <= 0x0d7f) indic += 1;   // Devanagari…Malayalam
    else otherNonAscii += 1;
  }
  return Math.ceil(ascii / 3.8 + indic / 1.2 + otherNonAscii / 2.2);
}
```

**Why an estimate, not a tokenizer?** Real BPE tokenization needs the provider's
vocabulary, so a "correct" count is correct for exactly one model. What the budget
needs is a *stable, conservative bound* computable thousands of times per second
with no network call.

**The script awareness is the point.** Indic text tokenizes far less efficiently
than Latin — roughly one token per character versus one per ~3.8. Assuming a flat
4 chars/token would silently blow the context budget for exactly the Hindi and
Marathi users this product serves.

`for (const ch of text)` iterates by **code point**, not UTF-16 code unit, so
characters outside the Basic Multilingual Plane count once rather than twice.

`AnthropicLlmProvider.countTokens()` wraps the exact endpoint for offline
calibration — which has not been run, and is stated as a known gap.

---

## `llm/llm.provider.ts` — the abstraction

```ts
export interface LlmRequest {
  systemStatic: string;    // request-invariant — cacheable
  systemDynamic: string;   // per-request
  messages: LlmMessage[];
  maxTokens: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}

export const LLM_PROVIDER = Symbol('LLM_PROVIDER');
```

The system prompt is **split into two fields** rather than one string. That is
not cosmetic: prompt caching is a prefix match, so the invariant span must be
separable for a provider to mark it cacheable.

The interface is deliberately tiny — one method. Anything a provider cannot do
(streaming, tools, structured output) is absent, so no provider has to fake it.

---

## `llm/prompt/prompt.builder.ts`

### `build()`

```ts
build(question: string, plan: PersonalizationPlan): BuiltPrompt {
  const contextBlock = this.renderContext(plan);
  const systemDynamic = this.renderSystemDynamic(plan);
  const userMessage = `${contextBlock}\n\nUSER QUESTION\n${question}`;
  // …
  return {
    systemStatic: SYSTEM_STATIC,
    systemDynamic,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: Math.max(2048, Math.ceil(plan.style.maxWords * 6)),
    tokens,
  };
}
```

**The question goes last**, after the context. Mild prompt-injection mitigation:
a question attempting to override instructions has already been preceded by the
rules.

### `maxTokens` — a bug worth understanding

```ts
maxTokens: Math.max(2048, Math.ceil(plan.style.maxWords * 6)),
```

The original was `Math.max(512, maxWords * 2.2)` — sized for the prose.

That **starved reasoning models**. Many free-tier models think visibly before
answering; a 250-word budget gave 550 tokens, the model spent all of it
reasoning, and was truncated before emitting any answer. The user received raw
chain-of-thought.

The cap is now sized for reasoning headroom. Length is enforced by the
instruction and by the output guardrail — `max_tokens` is only a runaway-cost
backstop, never the primary length control.

### `renderContext()` — why ids are in the prompt

```ts
private renderContext(plan: PersonalizationPlan): string {
  if (!plan.selected.length) return 'CONTEXT\n(no astrological context could be retrieved)';
  const lines = plan.selected.map((i) => `[${i.id}] ${i.label}: ${i.text}`);
  return `CONTEXT\n${lines.join('\n')}`;
}
```

The `[id]` prefix makes citations **machine-checkable**. Asking a model to "list
your sources" in prose yields plausible labels that verify against nothing;
asking for ids yields strings we can set-intersect with what we actually sent.

### The static prefix

```ts
export const SYSTEM_STATIC = `You are an experienced Vedic astrologer…

Hard rules:
- Use ONLY the astrological context supplied in the CONTEXT block…
- Describe tendencies, climate and timing. Never state a life event as certain…
- The chart describes conditions; the user makes the decision…`;
```

Byte-identical on every request. Contains no timestamp, no user name, nothing
per-request — because a single varying byte would invalidate the cache prefix.

---

## `llm/providers/mock.provider.ts`

Not a stub returning lorem ipsum. It **parses the CONTEXT block out of the prompt**
and composes an answer from the items it was actually given.

```ts
function parseContext(prompt: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  for (const line of prompt.split('\n')) {
    const m = /^\[([\w.]+)\]\s+([^:]+):\s+(.*)$/.exec(line.trim());
    if (m) out.push({ id: m[1], label: m[2], text: m[3] });
  }
  return out;
}
```

That is why the whole pipeline — selection, grounding, source verification,
confidence — can be exercised end to end with no API key, and why integration
tests are assertable.

### `humanise()`

```ts
function humanise(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();
  t = t.split(/(?<=\.)\s+/)
       .filter((s) => !/^(Do not|Reasoning is anchored)/i.test(s.trim()))
       .join(' ');
  t = t.replace(/This places the user roughly [\d.]+-[\d.]+% through the (\w+) chapter \((\w+) phase\)\./i,
                'You are in the $2 stretch of your $1 chapter.');
  t = t.replace(/\bthe user's\b/gi, 'your').replace(/\bthe user\b/gi, 'you');
  return t.trim();
}
```

Context items are written **for the model**, not the reader — third person, with
internal precision like "94.2–100% through the chapter", and occasionally
directives aimed at the model. A real provider rewrites all that naturally; the
mock must do it explicitly.

### The bug the mock caused

Its canned "analytical" opener used to read *"Health here is read from vitality
and the sixth house together."* For a user with an unknown birth time — whose
house context had been **withheld** — that sentence asserted a house we never
sent.

The groundedness verifier flagged `house 6` and dropped confidence from `HIGH` to
0.7. **A hallucination introduced by the generator rather than the data, caught
automatically.** The openers are now free of chart assertions.

---

## `llm/providers/anthropic.provider.ts`

```ts
const response = await this.client.messages.create({
  model: this.model,
  max_tokens: req.maxTokens,
  system: [
    { type: 'text', text: req.systemStatic, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: req.systemDynamic },
  ],
  output_config: { effort: 'low' },
  messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
}, { signal });
```

Three deliberate choices:

**Two system blocks with `cache_control` on the first.** Caching is a prefix
match, so the invariant span must be its own block. *Honest note:* Anthropic's
minimum cacheable prefix is ~1024 tokens and ours is well under, so caching
currently no-ops. Structured this way because the persona is exactly what grows.

**No `temperature`.** Sampling parameters are rejected with a 400 on Opus 5 /
Sonnet 5 and the 4.6+ family. Variability is controlled through effort instead.

**`effort: 'low'`.** The hard reasoning already happened deterministically
upstream — the model composes prose from settled conclusions. A latency trade
justified by the architecture, not a cost compromise.

### Typed errors

```ts
function normaliseAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) return new Error('…check ANTHROPIC_API_KEY.');
  if (err instanceof Anthropic.RateLimitError)      return new Error('Anthropic rate limit reached.');
  if (err instanceof Anthropic.BadRequestError)     return new Error(`Anthropic rejected the request: ${err.message}`);
  if (err instanceof Anthropic.APIConnectionError)  return new Error('Could not reach the Anthropic API.');
  if (err instanceof Anthropic.APIError)            return new Error(`Anthropic API error ${err.status}: ${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}
```

Most specific first. A single broad catch would lose the retryable /
non-retryable distinction the caller needs.

---

## `llm/providers/openai.provider.ts`

Raw HTTP rather than a second vendor SDK, because the chat-completions shape is
also accepted by OpenRouter, Groq, Cerebras, Together and most self-hosted
gateways. **One small adapter covers five vendors.**

```ts
readonly name: string;

constructor(private readonly opts: OpenAiProviderOptions) {
  this.model = opts.model;
  this.name = opts.label ?? 'openai';
}
```

`label` and `extraHeaders` are what let OpenRouter reuse this class without a new
file — it reports as `openrouter` in logs and sends attribution headers.

```ts
if (json.error) {
  throw new Error(`${this.name} upstream error: ${json.error.message ?? 'unknown'}`);
}
```

**OpenRouter can return HTTP 200 with an error object in the body** (free-model
capacity, upstream refusal). Checking only `res.ok` would return an empty answer
and never engage the fallback. Found by running against real free models.

---

## `llm/llm.module.ts` — the swap point

```ts
{
  provide: LLM_PROVIDER,
  inject: [APP_CONFIG, StructuredLogger],
  useFactory: (cfg: AppConfig, logger: StructuredLogger): LlmProvider => {
    switch (cfg.LLM_PROVIDER) {
      case 'anthropic': {
        if (!cfg.ANTHROPIC_API_KEY) {
          logger.warn('llm.provider_fallback', { requested: 'anthropic', reason: '…not set' });
          return new MockLlmProvider();
        }
        return new AnthropicLlmProvider({ … });
      }
      case 'openrouter': {
        // same adapter as openai, different base URL + two headers
        return new OpenAiLlmProvider({ …, label: 'openrouter',
          extraHeaders: { 'HTTP-Referer': cfg.OPENROUTER_APP_URL, 'X-Title': cfg.OPENROUTER_APP_NAME } });
      }
      default:
        return new MockLlmProvider();
    }
  },
}
```

**This is the only place in the codebase that knows which provider exists.**
Everything downstream depends on the `LlmProvider` interface.

Selection **degrades rather than crashes**: asking for a provider whose key is
missing logs a warning and falls back to the mock, so a missing environment
variable produces a working service rather than a boot failure.

Adding Gemini is a new class plus one `case`. Adding OpenRouter took nine lines
and no new class — which is the provider abstraction paying for itself.
