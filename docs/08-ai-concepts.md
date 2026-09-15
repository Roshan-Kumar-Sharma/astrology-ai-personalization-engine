# 8. AI & LLM Concepts

What AI/ML ideas this project uses, which it deliberately avoids, and the
vocabulary to discuss both.

---

## What kind of AI system is this?

**It is a context engineering / retrieval-augmented generation system, without a
vector store.**

The pipeline is structurally identical to RAG:

| RAG stage | Classic implementation | Here |
|---|---|---|
| Query understanding | Embed the query | **Lexicon intent + horizon extraction** |
| Retrieval | Vector similarity over chunks | **Concurrent API fan-out** |
| Ranking | Cosine similarity | **Rule-based scoring on `(intent × horizon)`** |
| Context assembly | Top-k chunks under a token budget | **Priority packing under a token budget** |
| Generation | LLM with retrieved context | Same |
| Post-processing | (often absent) | **Groundedness verification + safety review** |

**Why no embeddings?** RAG uses vector search because the corpus is unstructured
and relevance is fuzzy. Here the corpus is **small, structured, and finite** —
about 25 known fields per user. Relevance is not a similarity question, it is a
*domain rules* question: a career question needs the 10th house because Vedic
astrology says so, not because their embeddings are close.

Semantic search over 25 known fields would be slower, non-deterministic, and less
accurate than a lookup table. **Knowing when *not* to reach for embeddings is the
point.**

> If asked *"why not just use a vector DB?"*: because relevance here is
> deterministic and expressible as rules. Embeddings solve a problem I don't have,
> and would replace a testable lookup with an untestable approximation.

---

## Context engineering

The discipline this project is really about: deciding **what goes in the context
window** and in what form.

Three levers used:

**1. Selection** — of ~25 candidate items, send only what the question deserves.
For a career/quarter question: 10 kept, 18 discarded. Excluded items are *absent
from the prompt*, not ranked lower.

**2. Transformation** — send *conclusions*, not raw fields. `{"mahadasha":"Rahu",
"antardasha":"Mars"}` becomes a sentence stating it is the 9th of 9 sub-periods,
~12.6 months, closing an 18-year chapter.

**3. Budgeting** — a hard token ceiling per tier (free 320, premium 900), packed
greedily by priority with a relevance floor beneath it.

### The honest measurement

```
question                                  intent        sent  candidates  rawJSON
Should I consider changing my job…         career         330      606        230
How does this month look for my rel…       relationship   289      609        230
What should I focus on for my health?      health         223      591        230
TOTAL (6 sample questions)                               1541     3564       1380
```

Selection removes **57% of the candidate set**. But total prompt size is
*comparable to a raw JSON dump* (1541 vs 1380 tokens).

**This engine does not win by sending fewer tokens. It wins by sending different
ones.** The budget goes on derived conclusions the raw payload doesn't contain,
instead of on fields irrelevant to the question. Volume traded for grounding,
deliberately.

> Reporting this honestly is stronger than claiming a 60% saving against a
> strawman. If an interviewer asks "what's your baseline?", a fabricated number
> collapses immediately.

---

## Prompt engineering

### Structure

Three deliberately separated parts:

| Part | Content | Varies? |
|---|---|---|
| `systemStatic` | Persona, hard rules, anti-fatalism | **Never** — byte-identical every request |
| `systemDynamic` | Language, tone, length, jargon, scope, safety constraints, output contract | Per request |
| User message | Selected context + the question | Per request |

### Prompt caching

Caching is a **prefix match** — any byte change invalidates everything after it.
So invariant content must come first, in its own block, marked `cache_control`.

```ts
system: [
  { type: 'text', text: req.systemStatic, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: req.systemDynamic },
]
```

**Honest note:** Anthropic's minimum cacheable prefix is ~1024 tokens and our
static block is well under it, so **caching does not currently engage** — it
silently no-ops. It is structured this way because the persona is exactly what
grows in production, and marking it costs nothing today.

### Techniques used

- **Structured output via prompt contract** — ask for `{"answer":…,
  "usedContextIds":[…]}`. Not provider-native structured output, so the contract
  is identical across all providers ([D10](05-design-decisions.md)).
- **Content addressing** — every context line is prefixed `[derived.house.10]`.
  This makes citations *machine-checkable*; asking for sources in prose gets
  plausible labels that verify against nothing.
- **Negative instruction with a positive example** — the Hinglish directive
  failed when it only described the register. Adding a one-line exemplar fixed
  it. **This is a real, observed few-shot result**, not a theoretical claim.
- **Instruction hierarchy** — safety constraints are labelled "these override
  every other instruction" and placed after style.
- **Context-before-question ordering** — mild prompt-injection mitigation; the
  question cannot easily "get ahead of" the rules.

---

## Intent classification

A supervised-NLP problem solved without a model.

**Approach:** weighted term lexicon across English, romanised Hinglish and
Devanagari, plus multi-word phrase matching.

```
"changing my job" → phrase, career +2.0
"job"             → term,   career +1.0
                            career 3.0 vs all else 0
```

**Two subtleties worth knowing:**

1. **Longest match wins.** `"investments"` matches both `invest` and
   `investment`. Scoring both double-counts one piece of evidence and skews the
   margin. Entries that are substrings of other matched entries are dropped.

2. **Bounded inflection.** A bare prefix match (`\binvest`) catches
   *investment/investing* but also **investigation**. A full word boundary would
   break every inflection. Solution: the term may be followed only by a short
   list of real suffixes before the boundary.

Both were **found by tests**, not by inspection.

### Confidence calibration

```
margin   = (top − runnerUp) / top      how far ahead the winner is
strength = min(1, 0.6 + 0.4×top/1.5)   how much evidence existed at all
confidence = (0.45 + 0.55×margin) × strength
```

**Why both?** Margin alone reports near-certainty for a question matching one
weak keyword with no competitor. Strength alone ignores ambiguity. This is
ordinary score calibration — the same reasoning behind not trusting a softmax
probability from a single weak activation.

**Alternatives and why not:**

| Alternative | Why not |
|---|---|
| LLM classifier | Latency + cost + non-determinism for something "job" already answers |
| Embedding + kNN | Needs labelled examples; overkill for 7 classes with clear lexical markers |
| Fine-tuned classifier | Needs a labelled dataset that does not exist yet |

The classifier returns a *calibrated* confidence specifically so an LLM fallback
can be added for the ambiguous tail. It was left out rather than shipped
unmeasured.

---

## Grounding and hallucination detection

**The failure mode:** an LLM produces a fluent, confident sentence about "your
strong Venus" when Venus was never in the prompt. To a user who cannot check,
this is indistinguishable from a correct answer.

**The check:** we know exactly what went in, so anything named in the output but
absent from the input is invented *by construction*.

```
vocabulary ← every word from the selected context items
for each planet / sign / house named in the answer:
    if not in vocabulary → ungrounded
```

Plus **citation verification**: ids the model claims to have used are checked
against ids actually sent. Unknown ids are fabricated citations.

**Three severity levels feed confidence:**

| Signal | Penalty | Reasoning |
|---|---|---|
| Ungrounded entity | 0.30 each | Invented a fact |
| Fabricated citation | 0.10 each | Cited sloppily, may still be reasoning correctly |
| **Contract ignored** | 0.35 | Cannot verify *anything* — worst case |

**Honest limitation:** this is entity-level, not reasoning-level. A model can
invent an *interpretation* using only supplied entities and pass. It detects
fabricated facts, not faulty logic.

**It caught a real bug.** The mock provider's canned opener asserted "the sixth
house" for a user whose house context had been withheld. Flagged automatically;
confidence dropped `HIGH` → 0.7.

---

## Working with real models: four findings

All four appeared only once a live model was involved — invisible against a
well-behaved mock.

**1. Free tiers are disproportionately reasoning models,** and several emit
chain-of-thought as ordinary content. The first live run returned the model's raw
thinking as the answer. Fix: strip `<think>` blocks before parsing.

**2. `max_tokens` derived from the word budget starved them.** A reasoning model
spent its entire allowance thinking and was truncated before answering. Fix: size
the cap for reasoning headroom (`max(2048, words×6)`); enforce length via
instruction and the output guardrail instead.

**3. A model ignoring the JSON contract still reported `HIGH` confidence.** Fix:
`contractIgnored` now feeds the confidence score.

**4. Provider errors can arrive as HTTP 200** with an error object in the body.
Fix: inspect the body, not just the status, so the fallback path engages.

**Model selection was empirical, not reputational.** Seven free models were
probed against the real prompt shape and scored on: does it follow the JSON
contract, does it invent entities, how many output tokens, how fast. Two were
rate-limited, one was gated. `minimax/minimax-m3:free` won on prose quality and
2.5× token efficiency.

---

## Determinism, temperature, and reproducibility

**No `temperature` is sent to Anthropic** — sampling parameters are rejected with
a 400 on Opus 5 / Sonnet 5 and the 4.6+ family. Variability is controlled through
the effort setting instead.

`output_config: { effort: 'low' }` is used deliberately: the hard reasoning
already happened deterministically upstream, so the model is composing prose from
settled conclusions. That is a latency trade justified by the architecture, not a
cost compromise.

**The plan is fully deterministic** even though the prose is not. The same input
always produces the same intent, horizon, selection and confidence factors — which
is why the debug endpoint is a reliable diagnostic.

---

## Guardrails as an AI-safety pattern

Standard two-sided guardrail architecture:

```
input → [ INPUT GUARD ] → model → [ OUTPUT GUARD ] → user
```

**Input guard** (deterministic, pre-fetch): classify and block. Cheap, testable,
and stops a dangerous question from ever becoming a generated answer.

**Output guard** (deterministic, post-generation): catch what the model reached on
its own. Unsalvageable claims replace the answer; fatalistic phrasing is
rewritten.

**Why deterministic rewriting rather than a second model call?** It is cheaper,
faster, and makes the rule *enforced* rather than *requested*. A second LLM pass
to "make this safer" is itself probabilistic.

---

## What is NOT in this project, and why

| Technique | Why not |
|---|---|
| **Fine-tuning** | No labelled dataset; the domain logic is deterministic and belongs in code, not weights |
| **Embeddings / vector DB** | Corpus is ~25 structured fields; rules beat similarity |
| **Agents / tool-calling** | The flow is a fixed pipeline, not open-ended exploration. An agent would add latency and non-determinism for no gain |
| **Multi-turn / memory** | No thread id in the contract |
| **Streaming** | Contract returns a whole answer; a chat UI would want tokens |
| **LLM-as-judge eval** | The highest-value gap — needs the golden set first |
| **Reranking models** | Rule-based scoring is deterministic and explainable |

**Being able to say why you *didn't* use an agent framework is worth more than
having used one.** The strongest signal in an AI engineering interview is
matching technique to problem rather than reaching for the fashionable option.

---

## The efficiency insight

```
One full `npm run demo` run:  22 HTTP requests → 1 actual LLM call
```

Because `/debug/personalization` never generates, and blocked questions return
before generation.

**The highest-leverage optimisation in any LLM product is not making the model
faster — it is not calling it.** A large class of questions ("why did I get this
answer?", "is this question safe?", "what would you send?") is answerable with
zero generation.
