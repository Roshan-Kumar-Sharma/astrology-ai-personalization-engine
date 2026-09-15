# 5. Design Decisions

Every significant decision, the alternatives considered, and the honest cost of
choosing. **Every decision has a downside. Being able to name it is the point.**

---

## D1 — Selection keys on `(intent × horizon)`, not intent alone

**Decision.** Context selection is a function of *both* what is being asked and
*over what time period*.

**Why.** The brief's example config maps intent → context. But its own sample
questions span four time frames:

> "Can you summarize **today's** guidance?" · "What should I prioritize **this
> week**?" · "How does **this month** look…" · "…in the **next few months**?"

For "today" the panchang *is* the answer. Over "the next few months" it is
actively misleading — it describes one sunrise-to-sunrise window. The dasha is
the reverse. Selecting on intent alone throws that signal away.

**Alternatives rejected**

| Alternative | Why not |
|---|---|
| Intent only (as the brief sketched) | Cannot distinguish "today" from "this year" |
| Let the LLM decide relevance | Non-deterministic, untestable, costs a call, defeats the purpose of a selection layer |
| Separate intents like `career_today` | Combinatorial explosion — 7 intents × 7 horizons = 49 rule sets |

**Cost.** The rule config is more complex; every intent may need horizon
overrides. A reviewer must read two axes to predict behaviour.

**Nuance worth knowing.** Panchang is *dropped* at long horizons; the daily
horoscope is only *demoted*. The panchang is a point-in-time almanac with zero
persistence, while the horoscope is chart-derived and often echoes the running
dasha — weak signal, not none.

---

## D2 — Derive astrological conclusions before the LLM

**Decision.** A deterministic inference layer computes what the chart *means*
and feeds conclusions, not raw fields, into the prompt.

**Why.** `{"mahadasha":"Rahu","antardasha":"Mars"}` has an exact meaning: Mars is
the 9th of 9 sub-periods, ~12.6 months, closing an 18-year chapter. A model asked
to work that out will guess fluently and wrongly. Arithmetic belongs in code.

**Alternatives rejected**

| Alternative | Why not |
|---|---|
| Send raw JSON | Model invents the arithmetic; unverifiable |
| Explain Vimshottari rules in the prompt | Costs tokens every request to re-teach a fixed algorithm, and still doesn't guarantee correct output |
| Fine-tune a model on astrology | Enormous effort; still probabilistic where the answer is deterministic |

**Cost.** ~500 lines of domain code, and it requires genuine domain knowledge to
write and review. It also means we *commit* to an interpretation — if our
interpretation is wrong, it is confidently wrong.

**Honest limit.** The derived facts are correct arithmetic over the classical
rules, not the judgment of a practising astrologer. It computes *position*, not
*meaning* in a deep sense.

---

## D3 — Confidence is computed, never asked of the model

**Decision.** Five weighted factors plus hard caps. See
[Request Lifecycle](02-request-lifecycle.md) stage 10.

**Why.** Asking an LLM for a confidence score measures its fluency, not the
request. It will report `HIGH` on an answer built from a failed kundli call
because the prose came out well.

**Alternatives rejected**

| Alternative | Why not |
|---|---|
| Ask the LLM | Uncorrelated with the things that actually make an answer unreliable |
| Token logprobs | Measures the model's certainty about its *words*, not about the *data* |
| Always `HIGH` | Dishonest, and the field would carry no information |

**Cost.** The weights (0.30/0.20/0.20/0.15/0.15) and thresholds (0.75/0.55) are
**judgment calls, not calibrated against outcome data.** That is the weakest
point in the design and the honest answer if challenged: it is a *defensible*
scoring function, not a *validated* one. Calibration needs the eval set.

---

## D4 — Verify the answer against what was sent

**Decision.** Post-generation, check every planet/sign/house named in the answer
against the context we supplied. Build `sourcesUsed` from verified citations.

**Why.** We know exactly what went into the prompt, so anything named in the
output but absent from the input is invented *by construction*. In this domain a
confident sentence about "your strong Venus" is indistinguishable from a correct
one to a reader who cannot check.

**Cost.** Vocabulary matching is shallow — it catches *named entities*, not
wrong *reasoning*. A model can invent an interpretation using only supplied
entities and pass the check. It is a hallucination detector for facts, not for
logic.

**Real payoff.** This caught a genuine bug during development: the mock
provider's canned "analytical" opener asserted "the sixth house" for a user whose
house context had been withheld. Confidence dropped from `HIGH` to `0.7`
automatically.

---

## D5 — Safety is a pipeline stage, not a prompt instruction

**Decision.** A policy table screens the question *before* any fetch or LLM call.

**Why.** This is a mass-market consumer product. It will receive questions about
cancer prognoses, death timing, and self-harm. "Please be careful" in a system
prompt is not a control — it is a suggestion to a probabilistic system.

Screening first also means a question we will refuse never leaks the user id to
four services and never costs a generation.

**Alternatives rejected**

| Alternative | Why not |
|---|---|
| Prompt instructions only | Not enforced; bypassable; no audit trail |
| A classifier model | Latency, cost, and non-determinism on the safety path — the one place you least want it |
| Block after generation | Already paid for the answer; data already fetched |

**Cost.** Regex policies are **tuned to over-block** in medical and crisis
categories. *"I'm recovering from surgery, what does my chart say about my
energy?"* gets blocked. In this domain that is the right side to err on, and the
refusal redirects to what the engine can answer — but it is a real precision
loss, and I can state the trade rather than pretend it isn't there.

**Domain-specific detail worth knowing:** prenatal sex determination is refused
on legal grounds — it is a criminal offence in India under the PCPNDT Act, 1994,
and astrological framing does not exempt it.

---

## D6 — Rules as data, not code

**Decision.** All selection behaviour in `intent-rules.config.ts`; all safety
behaviour in `policies.config.ts`. `ContextSelector` has no per-intent branching.

**Why.** The brief explicitly warns against large if/else blocks. Beyond that:
rules-as-data can be diffed in review, unit-tested in isolation, and eventually
moved to a database or remote config without touching the pipeline.

**Cost.** Indirection. To answer "why did this item get excluded?" you read the
config *and* the selector, rather than one function. Mitigated by the debug
endpoint, which reports the reason per item.

---

## D7 — Mock upstreams over real HTTP, not stubbed functions

**Decision.** The bundled mock is a real HTTP server on its own port.

**Why.** Stubbing at the service boundary would make the concurrency, timeout,
retry, abort and partial-failure code *untested* — it would only run in
production. The same code path runs whether `UPSTREAM_*_URL` points at the mock
or at production.

**Bonus.** Fault injection (`MOCK_UPSTREAM_FAULT_RATE=0.9`) lets degradation be
*demonstrated* rather than asserted.

**Cost.** Slightly slower tests, one more moving part at boot, and a port that
can conflict (as it did during development).

---

## D8 — Stateless, no database

**Decision.** Nothing is persisted. Everything is fetched per request.

**Why.** The brief's contract has no thread id, so there is no conversation to
store. Horizontal scaling becomes trivial, and there is no schema to migrate.

**Cost.** No conversation memory — *"what about my finances?"* after a career
question restarts from zero. No analytics on what users ask. In-memory cache
means hit rate degrades linearly with replica count and resets on every deploy.

---

## D9 — Lexicon intent classification, not a model

**Decision.** Weighted multilingual term matching, ~3ms, deterministic.

**Why.** An LLM call per request to decide "is this a career question?" adds
latency, cost and non-determinism to something the word "job" already answers.
Deterministic classification is testable, cacheable and explainable.

**Cost.** It will not generalise to phrasings outside the lexicon. *"I'm thinking
of handing in my notice"* contains no lexicon term and falls to `general`. The
classifier returns a *calibrated* confidence precisely so an LLM fallback can be
added for that tail — I left it out rather than ship a path I could not measure.

---

## D10 — Prompt-level JSON, not provider-native structured output

**Decision.** Ask for a JSON object in the prompt; parse defensively.

**Why.** Anthropic's `output_config.format` is stricter, but the contract would
then differ per provider. Prompt-level JSON is identical across Anthropic,
OpenAI, OpenRouter and the mock, and a provider that ignores it degrades to
plain text rather than failing.

**Cost.** Weaker guarantee. Mitigated by `contractIgnored` feeding confidence —
a model that ignores the format is trusted less. A production system should use
native structured output per provider.

---

## D11 — Token estimation, not tokenization

**Decision.** A script-aware heuristic, not a real BPE tokenizer.

**Why.** Correct tokenization needs the provider's vocabulary, so a "correct"
count is correct for exactly one model. The budget needs a *stable, conservative
bound* computable thousands of times per second with no network call.

**The important detail:** the estimator accounts for script. Indic text tokenizes
far less efficiently than Latin — assuming a flat 4 chars/token would silently
blow the budget for exactly the Hindi and Marathi users this product serves.

**Cost.** It is an approximation. `AnthropicLlmProvider.countTokens()` wraps the
exact endpoint for offline calibration, but that calibration has not been run.

---

## D12 — Flat composition root

**Decision.** One `app.module.ts` rather than six feature modules.

**Why.** At three endpoints, a single wiring point reads better than six files of
`imports`/`exports` ceremony. The architectural boundaries are already enforced
by directory structure and by `astrology/` having no framework imports.

**Cost.** Does not scale. At ~15 services this should split into feature modules,
and the flat list would become a merge-conflict magnet on a larger team.

---

## D13 — Deterministic mock LLM provider

**Decision.** The default provider composes real prose from the actual selected
context, offline.

**Why.** Reviewers can evaluate the whole engine in 60 seconds with no signup.
Integration tests become assertable. Every stage except generation is exercised
end to end with no key and no network.

**Cost.** It composes **English only** — it does not translate. Language
personalization therefore had to be verified against a live model rather than
asserted (it was: Hindi and Hinglish both confirmed).

---

## Decisions deliberately *not* made

| Not done | Why | Where it's recorded |
|---|---|---|
| Auth / rate limiting | Out of scope for the brief; would be theatre without a real identity provider | README "production concerns" |
| Eval harness | The highest-value gap. Needs ~200 labelled questions to be meaningful, which exceeds the time budget | README "another day" |
| Transits (gochar) | The biggest missing astrological signal — Saturn over the 10th house is *the* career-change trigger. Not derivable from the four given services | [Astrology Concepts](07-astrology-concepts.md) |
| Streaming | A consumer chat UI wants tokens streamed; the contract returns a whole answer | README |
| Conversation memory | No thread id in the contract | D8 |

**Naming these is deliberate.** A gap you can articulate is a scoping decision;
a gap you cannot is an oversight.
