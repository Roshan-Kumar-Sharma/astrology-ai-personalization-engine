# Jev (TypeSafe AI) — evaluation note

**Date:** 2026-09-21 · **Status:** discussion only, nothing implemented ·
**Not linked from the docs index**, deliberately: Jev is an early-access product
and everything below has a short shelf life.

---

## What Jev actually is

Not a chatbot and not an LLM in the usual sense. TypeSafe AI calls it a **"System
One model"**: you send a block of **state** plus a set of **typed questions**, and
it returns **typed values with calibrated probabilities**. It evaluates every
question in the request in parallel, and it cannot generate strings at all.

Three question types:

| Type | You give it | You get back |
|---|---|---|
| `choice` | a set of options (up to 255) | a probability per option, plus an overall confidence |
| `score` | ordered levels (e.g. low/medium/high) | a continuous score, the distribution, and a confidence |
| `noul` | a yes/no statement | the probability the statement is true |

Reported figures (theirs unless noted):

- **Latency** 70–500 ms end to end; 0.4 s measured on DataCamp's write-up.
- **Cost** $0.042 per million input tokens. **Output tokens are free.**
- **Accuracy** 67.8% on TypeSafe's own four-workflow benchmark — effectively
  tied with GPT-5.6 Terra (67.9%) and **behind** GPT-5.6 Sol (74.1%) and Claude
  Opus 5 (73.1%), at $0.0004 per case against $0.0304–$0.1761.
- **Access** early access behind a waitlist; `POST https://api.typesafe.ai/v1/systemone`;
  US West Coast infrastructure; no announced free tier.

**Read that accuracy row carefully, because it is the whole shape of the
decision.** Jev is not more accurate than a good LLM. It is roughly as accurate
as a mid-tier one, at ~1% of the cost and ~1–2% of the latency, with a type-safe
output and a calibrated confidence attached.

For this project that is exactly the right trade in some places and exactly the
wrong one in others.

---

## The one-line verdict

**Yes, there is a real fit — but as a second, smaller port next to the LLM one,
behind a flag, measured before it is trusted, and never inside the engine.**
It would not replace the generation call; it would replace the two *decision*
calls that currently borrow a text model to do a classification job.

---

## Why it fits this codebase unusually well

Two model-backed features were added on 2026-09-21, and both do the same
awkward thing: they ask a **text generator** to make a **bounded choice**, then
spend code defending against the fact that it can say anything at all.

### 1. `IntentResolver` — the hard-coded confidence is the tell

[`src/personalization/intent/intent.resolver.ts:52`](../../src/personalization/intent/intent.resolver.ts):

```ts
const LLM_CONFIDENCE = 0.7;
```

with a comment explaining that this is a constant because the model's own
confidence is *"one unverifiable opinion"*, and that confidence in this service
is meant to be **computed from measurable factors rather than asserted**.

That constant exists solely because LLM confidence is not calibrated. **A
calibrated probability per intent is Jev's headline claim.** If the claim holds
on this data, that line becomes a real number rather than a placeholder, and the
`intentCertainty` factor (weight 0.15) in `ConfidenceService` starts carrying
information instead of a flat 0.7.

The rest maps one-to-one. `TAXONOMY` is already built from
`INTENT_RULES[i].description` — that same list becomes the `choice` options.
The JSON contract, the `extractJsonObject`/`stripReasoning` recovery and the
`maxTokens` tuning all become unnecessary on that path.

### 2. Secondary intents — the worst number in the eval, and a genuinely new capability

Secondary-intent recall is **7.7%**. The current approach asks the model to
*"list any clearly-present additional topics"* in a JSON array, which is a
generation task standing in for a multi-label one.

Jev's `choice` returns **a probability for every option**, so secondary intents
become "every intent above threshold *t*" — and *t* is tunable against the 120
labelled cases already in `eval/dataset/intent.jsonl`. This is the one place Jev
offers something the current design does not merely do more cheaply, but does
**better by construction**.

### 3. `LlmSafetyScreen` — the layer that exists to pick an id from a closed set

[`src/safety/llm-safety.screen.ts`](../../src/safety/llm-safety.screen.ts) already
constrains the model to a closed vocabulary: `CATALOGUE` is built from the policy
table, and `parsePolicyId` rejects anything that is not in `BLOCKING_IDS`. The
whole file is the shape of a `choice` question, implemented over a text API.

What disappears on a Jev path: the JSON extraction, the `<think>`-stripping, the
`maxTokens: 512` that exists because *"free-tier models are disproportionately
reasoning models"*, and the truncation failure mode. What stays exactly as it is:
the refusal copy, which must remain the policy's pre-reviewed `blockResponse` —
Jev **cannot** generate text, which here is a feature, not a limitation.

There is also a cost argument. That layer ships off partly because it screens
every allowed question, roughly doubling LLM calls on safe traffic. At $0.042/M
input with free output, that objection largely evaporates (arithmetic below).

### 4. LLM-as-judge for answer quality — the outstanding eval item, and the safest place to start

`README.md` item 1 still lists the LLM-as-judge rubric as unbuilt, because it
needs generation and so cannot live in the CI gate. A `score` question over
ordered levels ("does the answer address the question", "is it hedged
appropriately", "does it stay inside the context") is exactly the bounded-output
shape Jev is for.

**This is the lowest-risk entry point**: it runs offline over the eval set, not
on the critical path, so latency, availability and the waitlist stop mattering.
If Jev is disappointing here, nothing user-facing was ever at risk.

### 5. Groundedness — speculative

`GroundednessService` verifies entities deterministically and exactly, which
should stay. A `noul` per sentence ("this claim is supported by the context
below") might catch the *semantic* hallucination that names no planet, sign or
house and therefore slips past entity matching. Interesting, unproven, and
strictly additive — same asymmetric-trust rule as the safety layers.

---

## Where it must not go

1. **Not inside the engine.** `PersonalizationService.plan()` is synchronous and
   calls no model, by design — that is what makes it unit-testable and what lets
   the golden eval sweep 249 cases in about a second. A Jev call belongs in
   `personalize.service.ts`, concurrent with the upstream fan-out, handing its
   result down — the same rule `IntentResolver` and `LlmSafetyScreen` already
   follow.

2. **Not for context scoring.** `score` over candidate items is the most tempting
   idea here and the worst one. Deterministic, config-driven, explainable
   selection is the *thesis* of this repo — it is what makes "why did this user
   get this answer" answerable, what `npm run why` and the console are built on,
   and what lets the eval be free and deterministic. Trading that for a
   probability would be giving away the differentiator to save nothing.

3. **Not as a required dependency.** `npm install && npm start` has to keep
   working with no key and no account. Anything Jev-backed ships behind a flag,
   off by default, with the existing behaviour intact when it is absent — the
   pattern already set twice.

4. **Not for refusal text, ever.** It cannot generate, and the design already
   requires reviewed copy.

5. **Not on the strength of the calibration claim.** No independent
   reproduction has surfaced. Measure it here first — see below.

---

## What would have to change architecturally

**Jev is not a new `LlmProvider`.** That port is
`generate(req) → { text, ... }` ([`src/llm/llm.provider.ts`](../../src/llm/llm.provider.ts)),
and Jev cannot produce text. Wiring it in as a provider would mean faking a
string, which defeats the point.

It would need a **second, smaller port** alongside it — something like:

```ts
export interface DecisionProvider {
  readonly name: string;
  ask(state: string, questions: Record<string, Question>): Promise<Record<string, Answer>>;
}
```

with the same discipline the LLM port already has: an injection token, a mock
implementation for tests and CI, fail-open behaviour, and a four-way outcome
rather than a nullable — `off | answered | unavailable`, because
"the model saw nothing" and "the model never answered" must not collapse into
one value. That lesson cost a wrong measurement once already.

The payoff of the parallel-questions design: **intent, horizon, secondary
intents and the safety screen become one call, not two or four.** Adding
questions "barely changes the response time and costs only the tokens for the
extra questions."

---

## The arithmetic

**Cost per request.** A combined decision call would send roughly:

```
question text                          ~25 tokens
intent taxonomy (7 × description)     ~120
horizon options                        ~30
blocking-policy catalogue (CATALOGUE) ~250
light state / framing                 ~175
                                      -----
                                      ~600 input tokens, 0 output tokens
```

600 × $0.042 / 1,000,000 = **$0.0000252 per request**, or **$0.025 per thousand**,
or **$25 per million requests per day**. Against a single generation call of
~1,044 input + ~250 output tokens on any frontier model, this is rounding error.
DataCamp's sourced per-case comparison — $0.0004 vs $0.0304–$0.1761 — is the same
story: **76× to 440× cheaper**.

**Latency.** Current timeouts are `INTENT_LLM_TIMEOUT_MS=4000` and
`SAFETY_LLM_TIMEOUT_MS=4000`. Jev claims 70–500 ms, but its infrastructure is US
West Coast only and this product's users are in India — add roughly 200–300 ms
of round trip, so budget ~300–800 ms realistically.

That still fits: the decision call runs **concurrently with the upstream
fan-out**, whose deadline is `CONTEXT_FANOUT_DEADLINE_MS=2500`. Against real
upstreams the fan-out will not be the ~45–70 ms it is against the bundled mock,
so a sub-second decision call most likely hides entirely inside a window the
request was already paying for. **That is the actual case for Jev here** — not
accuracy, and not really cost either: *latency on the critical path* is the
reason `INTENT_LLM_FALLBACK` ships off.

---

## Unknowns that block a decision

1. **Multilingual support is undocumented, and this is the big one.** The engine
   handles English, Hindi (Devanagari), **Hinglish** (Latin-script Hindi) and
   Marathi. Hinglish intent classification is the hard case and the one a
   general-purpose LLM handles surprisingly well. None of the sources say
   anything about non-English input. Until tested against
   `eval/dataset/intent.jsonl`, assume nothing.
2. **Is the calibration claim true on this data?** Unverified by anyone
   independent, and it is the entire value proposition.
3. **Waitlist and no free tier.** A repo whose selling point is that it runs for
   anyone with `npm install && npm start` cannot depend on gated access. Also
   relevant if this is ever handed to a reviewer.
4. **Is 67.8%-class accuracy enough here?** The measured lift from the current
   free-tier LLM fallback is **+9.2 points** (73.3% → 82.5%). Whether Jev beats
   that on *this* taxonomy is unknown, and it could easily be worse.
5. **Pricing durability.** Early-access pricing on a venture-funded product is
   not a number to build a cost model on.

---

## How to find out cheaply — with tools this repo already has

The pleasing part: **the apparatus to evaluate Jev's headline claim already
exists**, because it was built to evaluate the lexicon's.

1. **`npm run eval:gate`** ([`eval/intent-gate.ts`](../../eval/intent-gate.ts))
   already answers "does this classifier's confidence predict its own
   correctness?" over 120 labelled cases. It consumes rows of
   `{ conf, method, ok }`. Feeding it Jev's per-intent probabilities instead of
   the lexicon's confidence is a handful of lines — and it directly tests the
   calibration claim on this domain, in this taxonomy, in four languages.
2. **`npm run eval:intent-llm`** already reports lift as fixed / broke / failure
   rate against the same golden set. Point it at a Jev-backed resolver and the
   comparison with the measured +9.2 points is apples to apples.
3. **`npm run eval:safety-llm`** already scores a second safety layer on
   `safety-probe.jsonl` — the 24 pattern-blind cases where deterministic recall
   is **1/14 (7.1%)** at zero false positives — and refuses to print a lift when
   more than 25% of calls fail. Read the **false-positive** column first: a
   screen that refuses *"will this job kill my creativity?"* is worse than no
   screen.
4. **Secondary intents**: sweep the per-option probability threshold against the
   same 120 cases and see whether 7.7% recall moves at all.

Nothing above needs a line of production code. All four are measurements, and if
the numbers are not there, the answer is simply no.

---

## If asked about this in an interview

> *"A new model class showed up that does typed decisions instead of text. Two
> features in this engine ask a text model to make a bounded choice and then
> spend real code defending against the fact that it can say anything — a JSON
> contract, reasoning-token stripping, a closed-vocabulary parse, a hard-coded
> 0.7 confidence because the model's own number means nothing. All of that is
> scaffolding around a mismatch between the tool and the job.*
>
> *So the fit is obvious and I still would not ship it yet. It is early access,
> its accuracy is mid-tier rather than best, nobody has independently reproduced
> the calibration claim that is its entire pitch, and there is no published
> evidence it handles Hinglish — which is a third of my traffic. What I would do
> is measure it with the three eval commands already in the repo, starting with
> the offline answer-quality judge where nothing user-facing is at risk, and
> ship it the same way the other two model-backed features shipped: behind a
> flag, off, with the command that measures it on your own traffic."*

That answer is worth more than the integration would be.

---

## Sources

- [Introducing System One Models & Jev — TypeSafe AI](https://typesafe.ai/blog/introducing-system-one-models-and-jev)
- [What Is Jev? A Guide to TypeSafe AI's System One Model — LangChain](https://www.langchain.com/blog/building-a-harness-with-jev)
- [Jev: TypeSafe's System One Model That Never Hallucinates — DataCamp](https://www.datacamp.com/blog/system-one-models-jev)
- [A deep dive into Jev — Flavio Copes](https://flaviocopes.com/jev/)
- [Jev Explained — MindStudio](https://www.mindstudio.ai/blog/jev-system-one-model-launch)

All figures above are vendor-reported or from those write-ups; none were
measured here.
