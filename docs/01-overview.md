# 1. Overview

## The problem

MyNaksh is an AI Vedic astrology app. A user types a question — *"Should I
consider changing my job in the next few months?"* — and expects a personal
answer based on their actual birth chart, in their language, in a tone that
suits them.

Behind that sit four backend services from the brief, plus a transit service added later, that return structured data:

| Service | Returns | Changes |
|---------|---------|---------|
| **User** | name, language, subscription, tone preference, birth details | when the user edits settings |
| **Kundli** | ascendant, moon sign, current planetary period, house data | chart is fixed at birth; the period pointer moves |
| **Horoscope** | four one-line daily readings (career/finance/health/relationship) | daily |
| **Panchang** | the day's almanac: tithi, nakshatra, yoga, karana | daily, at sunrise |
| **Transit** | where Saturn, Jupiter, Rahu and Ketu are in the sky right now | slowly; a sign change every 1–2.5 years |

And in front sits an LLM that writes prose.

**The gap between them is this service.** The brief calls it the *Personalized
AI Context Engine*.

## Why the naive version fails

The obvious implementation is four lines long:

```ts
const [user, kundli, horoscope, panchang] = await Promise.all([...]);
return llm.generate(`${JSON.stringify({user, kundli, horoscope, panchang})}\n${question}`);
```

It runs. It produces plausible text. And it is wrong in five specific ways:

1. **It sends the relationship horoscope to answer a career question.** Irrelevant
   context does not merely waste tokens — it actively pulls the answer off-topic.
2. **It cannot tell "today" from "the next six months."** The panchang is the
   entire answer for one and pure noise for the other.
3. **It asks the model to do arithmetic.** `{"mahadasha": "Rahu", "antardasha":
   "Mars"}` means something precise and computable. A model will guess, fluently
   and wrongly.
4. **It cannot say how sure it is.** If the kundli service was down, the answer
   is generic — but it will *sound* identical to a fully-informed one.
5. **It will answer "when will I die?" and "will my mother's cancer be cured?"**

Each of those is a real product failure, not a theoretical one. The engine
exists to fix them.

## The mental model

Think of it as an **experienced astrologer's assistant** who prepares the desk
before the astrologer sits down.

The assistant:

- reads the question and works out what is actually being asked, and about what
  time period *(intent + horizon)*
- pulls only the relevant pages from the client's file *(context selection)*
- does the calendar arithmetic in advance — "this period ends in about twelve
  months, and it's the last one in an eighteen-year cycle" *(derived facts)*
- notes on a sticky: *"birth time is uncertain — don't rely on the houses"*
  *(chart reliability)*
- refuses to put a medical question on the desk at all *(safety)*

The astrologer (the LLM) then writes the answer, using only what is on the desk.
Afterwards the assistant checks the answer against the desk — if it mentions
Venus and Venus was never on the desk, that gets flagged.

**The LLM's job is narrow: turn settled conclusions into good prose.** Everything
requiring correctness happens before or after it.

## What "personalization" means here

Not one thing — five independent axes, each from a different source:

| Axis | Decided by | Example |
|------|-----------|---------|
| **What data** | intent × time horizon | career question → 10th house, not 7th |
| **How much data** | subscription tier | free 320 tokens, premium 900 |
| **Language** | user profile | English / Hindi / Hinglish / Marathi… |
| **Tone** | user preference | motivational / gentle / analytical / direct |
| **Length & jargon** | tier × horizon × intent | 120 words plain, or 250 words with Sanskrit terms |

A naive implementation personalizes only language and tone. The interesting
axis — *what data this question deserves* — is the one the brief is actually
testing.

## What was built

- **`POST /personalize`** — the answer endpoint. Returns exactly
  `{ answer, confidence, sourcesUsed }`.
- **`POST /debug/personalization`** — same pipeline, no LLM call, returns the
  engine's reasoning instead of prose.
- **`GET /console`** — the debug console: one self-contained HTML page that
  drives the debug endpoint and renders the whole decision. Free to run.
- **`GET /health`** — liveness and cache stats.

Plus a bundled mock of all five upstream services over real HTTP, so the whole
system runs with `npm install && npm start` and no configuration.

## Scale of the thing

| | |
|---|---|
| Production TypeScript | ~4,600 lines |
| Tests | 130, across 8 suites |
| Runtime dependencies | 10 |
| Endpoints | 3 |
| Databases | 0 |
| Config needed to run | none |

## Vocabulary you need

Five terms carry most of the codebase. Full detail in
[Astrology Concepts](07-astrology-concepts.md).

- **Lagna / ascendant** — the zodiac sign rising on the eastern horizon at the
  moment of birth. Sets the entire house layout. Moves roughly one degree every
  four minutes, which is why birth-time accuracy matters so much.
- **Rashi / moon sign** — the sign the Moon occupied at birth. Changes every ~2.25
  days, so it survives an inaccurate birth time.
- **Bhava / house** — twelve life areas. The 10th is career, the 7th is marriage,
  the 6th is daily work and illness.
- **Dasha** — planetary period. Life is divided into chapters ruled by one of nine
  planets. `mahadasha` = major period (6–20 years), `antardasha` = sub-period.
- **Panchang** — the daily almanac: five components describing the quality of a
  given day.
