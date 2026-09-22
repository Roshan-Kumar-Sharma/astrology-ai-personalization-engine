# 10. Interview Guide

Written from the interviewer's chair. These are the questions this project
invites — including the ones designed to find cracks.

**The rule that matters most: never bluff.** This codebase has real weaknesses,
and they are documented. An interviewer who finds one you've already named
concludes you have judgment. An interviewer who finds one you're defending
concludes you don't.

---

## Part 1 — The opening

### "Walk me through what you built."

Ninety seconds. Do not narrate the file tree.

> "The brief was to build the layer between four structured astrology services
> and an LLM. The naive version is four lines — fan out, dump the JSON in a
> prompt, return the answer. It runs, and it's wrong in five specific ways.
>
> It sends the relationship horoscope to answer a career question. It can't tell
> 'today' from 'the next six months', which matters because the daily almanac is
> the whole answer to one and noise for the other. It asks the model to do
> arithmetic it will hallucinate. It can't tell you how confident it is. And it
> will happily answer 'when will I die'.
>
> So I built a pipeline where the LLM does one narrow job — turning settled
> conclusions into prose — and everything requiring correctness is deterministic
> code with tests. Ten stages: safety screening first, then concurrent fan-out,
> intent and time-horizon extraction, astrological inference, rule-based context
> selection under a token budget, prompt assembly, generation, groundedness
> verification, and a computed confidence score.
>
> 130 tests. Runs with no API key because the default provider is a deterministic
> mock that composes real prose from the actual selected context."

### "What's the one thing you're proudest of?"

Pick the dasha insight. It is concrete, domain-specific, and impossible to fake.

> "The brief's own sample data says `mahadasha: Rahu, antardasha: Mars`. That
> looks like an arbitrary pointer. It isn't.
>
> Vimshottari dasha divides life into chapters on a fixed 120-year cycle.
> Sub-periods within a chapter run in a known order starting with the chapter's
> own lord. Working through it: Mars is the *ninth of nine* sub-periods of an
> eighteen-year Rahu chapter, lasting `18 × 7 / 120` — about 12.6 months. So this
> user is in the final year of an eighteen-year chapter, with a Jupiter chapter
> starting next.
>
> For 'should I change my job in the next few months?', that isn't context —
> that's the answer. A chapter boundary is exactly when re-orientation is
> structurally expected. And it's completely invisible in the raw JSON.
>
> That's what convinced me the derived-facts layer had to exist. Hand an LLM two
> strings and it guesses. Compute it and the answer is exact, testable, and free."

---

## Part 2 — Architecture

### "Why ten stages? Isn't that over-engineered for three endpoints?"

> "Each stage exists because removing it produces a specific failure. Safety
> first because a question we'll refuse shouldn't leak the user id to four
> services or cost a generation. Inference before selection because derived facts
> are themselves selectable context. Verification after generation because that's
> the only place hallucination is detectable.
>
> The whole pipeline runs in 61ms against a 9.9-second LLM call. It isn't
> over-engineered on latency. It's more *code* than the naive version, and that's
> the deliberate trade — I'm buying testability and explainability."

### "Why is the selector separate from the rules?"

> "So that adding an intent is a config entry, not a code change. `ContextSelector`
> has no astrology in it and no per-intent branching — its only job is applying
> rules consistently. The brief explicitly warned against large if/else blocks.
>
> The bonus is that rules-as-data can be diffed in review, tested in isolation,
> and eventually moved to a database without touching the pipeline. The cost is
> indirection: to answer 'why was this excluded?' you read the config *and* the
> selector. That's why the debug endpoint reports the reason per item."

### "How would you add a fifth upstream service — say, transits?"

This one is no longer hypothetical: transits **were** the fifth service, added
on 2026-09-22. Answer from what actually happened, because the prediction and
the reality differ in an instructive way.

> "The prediction was 'four things, none of which touch the pipeline', and that
> held: a type and a URL, one `track()` line in the aggregator — which inherited
> retry, timeout, circuit breaking and caching for free — a TTL, and the items
> plus their rule ids. TypeScript found every seam that enumerates sources; the
> TTL switch wouldn't compile until the new case was written.
>
> What the prediction missed was everything *after* wiring. The derived facts
> were the real work, and the golden eval failed on the first run — correctly.
> Promoting `derived.transit.*` by wildcard admitted 'Jupiter over the 4th house'
> into a career answer; the three statements cost 62% of a free-tier budget; and
> 'Is Sade Sati affecting me?' dropped the one fact that answers it to a token
> tie-break, which needed a third question-text signal — the planet a question
> names. Adding the source was an afternoon. Making the engine *reason* with it
> well was the feature."

### "Walk me through what happens when the Kundli service goes down."

> "`UpstreamClient.fetch` never throws — a failed source is a *result*, not an
> exception. So:
>
> Two retries with full-jitter backoff. Jitter specifically because every request
> fans out to four services at once; without it a blip makes all callers retry in
> lockstep and stampede the recovering service. Then a stale-cache check — a
> six-hour-old chart beats an error page. If that fails too, the source is marked
> `failed` and the pipeline continues.
>
> Downstream, the confidence calculator applies a hard cap: no kundli means no
> personalised astrology, so it's capped at 0.5 — `MEDIUM` at best — with a cap
> reason the debug endpoint surfaces. After five failures the circuit breaker
> opens, which protects *our* latency budget more than the upstream's load.
>
> I verified this rather than assuming it — at a 90% injected failure rate, every
> request still returns 200 with `LOW` confidence and explanatory caps."

---

## Part 3 — The domain

### "You're not an astrologer. How do I know the astrology is right?"

The honest answer is stronger than a confident one.

> "You can check it, and that's deliberate. Every rule comes from a table in
> `zodiac.ts` or `vimshottari.ts` — sign rulership, exaltation, the dasha cycle.
> Those are fixed classical facts, not interpretations. A reviewer who knows the
> domain can verify any claim against the classical rule rather than trusting my
> code.
>
> The strongest evidence is that the *brief's own sample data* validates against
> my implementation. A Libra lagna puts Pisces on the 6th, Aries on the 7th,
> Cancer on the 10th — Jupiter, Mars, Moon. That's exactly what their payload
> says. I didn't hard-code that; it falls out of the rulership table, and I check
> it on every request.
>
> What I'm *not* claiming is astrological judgment. The engine computes
> *position* — where you are in a cycle, which house a lord governs. It doesn't
> do synthesis the way a practising astrologer would."

### "Your health mapping doesn't match our example config."

> "Correct, and deliberately. Your example maps health to the 6th house. The 6th
> is *illness* — but the 1st house is the vitality and constitution that resists
> it, and the Moon governs the mind, which matters for anything mental-health
> adjacent. Stopping at the 6th gives you a disease reading, not a health reading.
>
> Same reasoning on career: the 10th is profession and status, but the 6th is
> daily work and service — where an *employed job* actually sits — and the 11th is
> gains from it. I used 10 as primary, 6 and 11 as secondary.
>
> If your astrologers disagree, it's a one-line config change. That's the point of
> the rules being data."

### "What astrology did you deliberately not model?"

> "Divisional charts — D-10 is *the* career chart and a serious career reading
> would use it. Aspects, yogas, Ashtakavarga, Mangal Dosha, Ashtakoot compatibility.
>
> They share one root cause: the payload gives house *lords* and *strength labels*,
> not planetary positions in degrees. That's the ceiling on how deep the inference
> can go. I'd rather name the ceiling precisely than list techniques I didn't use."

---

## Part 4 — AI and LLM

### "Why not use embeddings or a vector database?"

> "Because relevance here isn't a similarity question. RAG uses vector search
> because the corpus is unstructured and relevance is fuzzy. My corpus is about
> 25 known structured fields per user, and a career question needs the 10th house
> because Vedic astrology says so — not because their embeddings are close.
>
> Semantic search over 25 known fields would be slower, non-deterministic, and
> less accurate than a lookup table. Embeddings would solve a problem I don't
> have, and replace a testable rule with an untestable approximation.
>
> Structurally this *is* RAG — query understanding, retrieval, ranking, context
> assembly, generation — just with API calls instead of a vector store, and rules
> instead of cosine similarity."

### "How do you know the LLM isn't making things up?"

> "I check. Because I know exactly what went into the prompt, anything named in
> the output but absent from the input is invented by construction.
>
> Every context line is prefixed with an id like `[derived.house.10]`, and the
> model is asked to cite which ones it used. Those citations get verified against
> what was actually sent. Separately, I scan the answer for planets, signs and
> houses and check each against the supplied vocabulary. `sourcesUsed` is built
> from *verified* citations, so it describes what the answer actually rests on.
>
> It caught a real bug. My own mock provider had a canned opener asserting 'the
> sixth house' — and it fired for a user whose birth time was unknown and whose
> house context had therefore been withheld. Flagged automatically, confidence
> dropped from HIGH to 0.7.
>
> The honest limitation: it's entity-level, not reasoning-level. A model can
> invent an *interpretation* using only supplied entities and pass the check."

### "Why not just ask the LLM for a confidence score?"

> "Because it measures the model's fluency, not the request. It'll report HIGH on
> an answer built from a failed kundli call and an unknown birth time, because
> the prose came out well.
>
> Mine is computed from things the service actually knows: which upstreams
> answered weighted by how much each matters, whether we found primary-tier
> context for this question, how sure the classifier was, whether the birth time
> can support house-level claims at all, and whether the answer stayed inside the
> context.
>
> Plus hard caps, because some failures are categorical rather than gradual. No
> kundli means no personalised astrology however well everything else went."

### "Why is birth time a confidence factor? That seems oddly specific."

This is the question that most rewards domain knowledge.

> "It's the highest-leverage factor in the whole system.
>
> The ascendant moves about one degree every four minutes. A birth time rounded to
> the nearest half hour can put it in the wrong sign entirely — and *the entire
> house layout derives from the ascendant*. So every house-based statement becomes
> wrong, while sounding exactly as confident.
>
> A real astrologer handles this by falling back to Moon-sign reasoning — the Moon
> stays in a sign for about 2.25 days, so it survives a birth time wrong by hours.
> The engine does the same: house context is *removed from the prompt entirely* —
> not down-ranked, because a budget surplus must never let an unsound statement
> back in — the prompt is told not to mention houses, and confidence is capped at
> MEDIUM.
>
> A generic pipeline sends the houses regardless and states them with full
> confidence."

---

## Part 5 — Engineering

### "How did you test this?"

> "130 tests across 8 suites. The distribution reflects risk: 26 on guardrails —
> including false positives, because over-blocking makes the product useless — 21
> each on the answer layer and intent, 20 end-to-end.
>
> The e2e suite runs over real HTTP against the mock upstream on its own port,
> deliberately not stubbed at the service boundary. Concurrency, retry, timeout
> and partial-failure code only means something if a socket is involved.
>
> Three real bugs were found by tests, and they're the kind that ship silently:
> a wildcard `panchang.*` didn't match `derived.panchang.lord`, so a derived
> panchang fact survived a horizon that drops the panchang entirely. `\binvest`
> matched 'investigation'. And `invest` plus `investment` both scored on
> 'investments', double-counting one piece of evidence."

### "What would you do differently?"

> "The eval harness, and I'd do it first rather than last. Right now I can prove
> the engine is *consistent* — same input, same plan — but not that it's *good*.
> Are the confidence weights right? Is 30 the right relevance floor? I can defend
> those numbers as reasonable; I can't defend them as measured.
>
> A golden set of ~200 labelled questions with expected intents and sources, plus
> an LLM-as-judge rubric for answer quality, would turn every tuning argument into
> a measurement. That's the single biggest gap."

**Both halves of that are now built** — 261 labelled cases in `eval/`, and
`npm run eval:judge` for answer quality. If you give this answer, give it in the
past tense and lead with what the measurement found rather than that it exists:
intent accuracy 74.2%, a held-out safety probe at 43.8%, and a judge that the
regex verifier out-scored on the one dimension both can see.

### "Where's the weakest code?"

Answer this honestly; it's a character test.

> "Three places.
>
> The confidence weights — 0.30, 0.20, 0.20, 0.15, 0.15 — are judgment calls, not
> calibrated against outcomes. Defensible, not validated.
>
> The guardrails are regex, tuned to over-block in medical and crisis categories.
> 'I'm recovering from surgery, what does my chart say about my energy?' gets
> blocked. In this domain I think that's the right side to err on, but it's a real
> precision loss.
>
> And the token estimator is a heuristic, not a tokenizer. I wrapped Anthropic's
> exact counting endpoint for calibration but never ran the calibration."

---

## Part 6 — Stack

### "Why NestJS and not Express or Fastify?"

Lead with the fact that surprises people.

> "First — it *is* Express. NestJS ships `platform-express` by default. It's not
> an alternative to Express, it's a structural layer on top of it. So the real
> question is why add the structure.
>
> Because the brief grades on 'swappable LLM provider' and 'extensible engine',
> and a DI container turns those from intentions into bindings. The provider is a
> symbol resolved once at boot; nothing downstream knows which one is active. With
> bare Express that's a hand-rolled service locator or threading it through every
> function.
>
> Why not Fastify: the LLM call is 9.9 seconds and the entire framework overhead
> is under a millisecond. Fastify's 2–3× throughput advantage would optimise 0.6%
> of request time. And if I ever needed it, it's a one-line adapter swap because
> the application code never touches the HTTP layer.
>
> The honest cost: 627 packages, decorator magic that obscures control flow, and
> DI resolution errors that cost me two real debugging cycles. For three endpoints
> it's arguably heavy."

### "Would you have chosen a different language?"

> "Python/FastAPI, if your AI stack is Python. The eval and embedding ecosystem is
> stronger and Pydantic is comparable to zod. The domain layer is pure functions —
> it'd port in about an hour.
>
> I chose TypeScript because the engine is fundamentally about *shapes of data*,
> and because `Record<Intent, IntentRule>` makes the config table exhaustive by
> construction — adding an intent fails to compile until a rule exists for it.
> That's a real correctness property."

---

## Part 7 — The hard questions

These are designed to find cracks. Each has an honest answer.

### "Your token savings claim doesn't hold. You send *more* than a raw JSON dump."

**Do not get defensive — you already documented this.**

> "Correct, and it's in the README with the numbers. 1541 tokens versus 1380 for a
> raw dump across the six sample questions.
>
> The engine doesn't win by sending fewer tokens; it wins by sending *different*
> ones. Selection removes 57% of the candidate set, and the budget goes on derived
> conclusions the raw payload doesn't contain — where the user stands in an
> eighteen-year dasha, which houses the sub-period lord governs — instead of on
> fields irrelevant to the question. Volume traded for grounding, deliberately.
>
> I'd rather report that than claim a 60% saving that collapses the moment you ask
> what the baseline was."

### "The `general` intent sends almost everything. Isn't that the naive version?"

> "It's the weakest rule and the most likely to need tuning. Right now it sends a
> thin slice across areas rather than everything — the relevance floor still
> applies, so background items get excluded even with budget to spare.
>
> But you're right that 'general' is where selection has the least to work with.
> The better fix is the LLM intent fallback: `general` mostly means the lexicon
> found nothing, which is exactly the ambiguous tail worth paying an LLM call for.
> The classifier already returns a calibrated confidence to gate that. I left it
> out rather than ship a path I couldn't measure."

### "You block 'I'm recovering from surgery, how's my energy?' That's a real user you're failing."

> "Yes. That's a genuine false positive and I know about it.
>
> The medical policy matches on a combination — a disease or procedure term plus
> prognosis language — because a single regex is too brittle for the case that
> matters. 'Will my mother's cancer be cured' slips past a pattern written for
> 'will cancer be cured'; the possessive breaks it.
>
> Tuned that way, recovery questions get caught. I chose that side deliberately:
> in a self-service product with no human present, wrongly refusing a wellbeing
> question costs a mildly annoyed user, and wrongly answering a prognosis question
> can delay treatment. The block response also redirects to what I *can* answer.
>
> The right fix isn't loosening the regex — it's the escalation path. The policy
> already carries `escalateToHuman`, and MyNaksh has real astrologers. That
> question should route to one."

### "Your intent classifier fails on 'I'm thinking of handing in my notice.'"

> "It does. No lexicon term, so it falls to `general` with 0.3 confidence.
>
> That's the tail the LLM fallback is designed for, and the confidence score is
> calibrated specifically so it can be gated on cheaply — only pay for the
> ambiguous cases. In production I'd measure what fraction of real traffic lands
> in `general` before deciding.
>
> The lexicon handles the sample questions and common phrasings for free in three
> milliseconds. I'd rather have a fast deterministic path plus a measured fallback
> than an LLM call on every request."

### "Isn't the whole thing over-engineered for an assignment?"

> "For an assignment, probably. The brief said it cared more about architecture and
> design decisions than feature count, so I optimised for that.
>
> The parts I'd defend as necessary in production regardless: the safety layer,
> because this is a consumer product that will get medical and crisis questions;
> the resilience layer, because four upstream dependencies means partial failure
> is normal; and computed confidence, because a wrong-but-confident astrology
> answer is a real harm.
>
> The parts that are arguably scope: three test users instead of one, the
> deterministic mock provider, and the Docker setup."

### "Show me where a bug could still hide."

> "The output guardrail is regex over generated text, and generated text is
> unbounded. I catch death predictions, medical claims and absolute phrasing in
> English. A Hindi answer making the same claim would sail through — every output
> rule is English-only. That's a real gap for a product whose main market isn't
> English-speaking.
>
> Second: groundedness is entity-level. A model can invent an interpretation using
> only supplied entities and pass.
>
> Third: the panchang has no location parameter, so every user shares one
> panchang. Since the panchang day runs sunrise to sunrise, that's wrong for users
> far from the reference longitude — most visibly for the diaspora."

---

## Part 8 — Likely extension exercises

They may ask you to design something live.

**"Add a compatibility intent for two users."** → Second `userId`, second chart
fetch (the aggregator is generic), Ashtakoot Guna Milan in `astrology/`, a new
rule entry. The interesting problem is that context selection now spans *two*
charts, so `ContextItem` needs an owner field.

**"Support conversation memory."** → Thread id in the contract, plan-hash storage,
and the real design question: does a follow-up re-run intent classification, or
inherit? Answer: re-run, but treat the previous intent as a prior.

**"Cut latency in half."** → Not by optimising the engine — it's 61ms of 9.9s.
Streaming for perceived latency; a response cache on the plan hash for real
latency; a smaller model for simple intents; and prompt caching once the static
prefix crosses 1024 tokens.

**"Make it work for 1M users/day."** → Redis for cache and circuit-breaker state;
per-user LLM budgets; response caching (identical `(user, question, day)` triples
are common); and a queue for non-interactive questions.

---

## Part 9 — Questions to ask them

Asking good questions signals seniority.

- "What fraction of your questions fall outside clear intent categories? That
  determines whether the LLM fallback is worth building."
- "Do you have astrologers reviewing AI answers today? I built an escalation flag
  but no routing — I'd want to know what the human loop looks like."
- "How do you currently measure answer quality? I built an LLM-as-judge and
  calibrated it by mutation — 0 false positives on clean answers, but it missed
  3 of 5 defects appended to an otherwise good answer. I'd want to grade against
  your rubric rather than the one I invented."
- "Is the panchang service location-aware internally? The contract in the brief
  has no location parameter, and the panchang day is sunrise-based."
- "What's the language split in production? Hinglish needed a different prompt
  treatment than Hindi, and I'd want to know how much traffic that affects."

---

## Numbers to have memorised

These were last re-measured on 2026-09-22, after the transit service landed.
Where a figure moved, the old one is in brackets — you will be asked what
changed and why.

| | |
|---|---|
| Tests | **329** across 16 suites *(was 130 / 8)* |
| Engine latency | **61ms** — LLM **9.9s** (99.4%) |
| Fan-out | **5** services, parallel *(4 before transits)* |
| Selection | **58%** of candidate set removed |
| Tokens | **2057** sent vs **1674** raw dump — 23% *more*, and deliberately so *(was 1541 / 1380, 12%)* |
| Intent / horizon accuracy | **74.2%** / **87.9%**, 124 cases |
| Safety | 100% block recall — but **43.8%** on a cold held-out probe |
| Selection eval | **94.1%** pass, **100%** exclusion-reason accuracy |
| Judge calibration | **20/25** defects caught, **0/8** clean answers wrongly failed |
| Dasha example | Rahu/Mars = 9th of 9, `18×7/120` = **12.6 months** |
| Confidence | 0.30 data / 0.20 coverage / 0.20 birth time / 0.15 intent / 0.15 grounding |
| Thresholds | HIGH ≥ 0.75, MEDIUM ≥ 0.55 |
| Scoring | primary 100, secondary 55, neutral 15, floor 30 |
| Demo cost | 22 HTTP requests → **1** LLM call |
| Dependencies | 10 runtime |

---

## The three sentences to land

If the conversation gives you nothing else, get these in:

1. **"Rahu-Mars is the ninth of nine sub-periods — this user is at a chapter
   boundary, and that's invisible in the raw JSON."** *(domain depth)*
2. **"Confidence is computed from data completeness and birth-time reliability,
   never asked of the model."** *(engineering judgment)*
3. **"It sends more tokens than a raw dump, not fewer — it wins by sending
   different ones."** *(intellectual honesty)*
