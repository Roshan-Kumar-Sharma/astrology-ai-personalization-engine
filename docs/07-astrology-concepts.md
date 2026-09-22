# 7. Astrology Concepts

Written for someone who knows nothing about Vedic astrology. You need this to
defend the domain modelling — and the domain depth is a large part of what makes
this project stand out.

> **Framing for an interview.** You are not claiming astrology is predictive. You
> are claiming that *if* you build a product on a symbolic system, you should
> model that system **correctly and internally consistently** — the same rigour
> you'd apply to tax rules or a game's mechanics. Correctness here means
> faithful to the classical rules.

---

## The four building blocks

### 1. Lagna (ascendant) — the frame

The zodiac sign rising on the eastern horizon at the exact moment and place of
birth.

**Why it dominates the design:** the ascendant advances through all twelve signs
in ~24 hours — roughly **one degree every four minutes**. A birth time wrong by
half an hour can place it in the wrong sign entirely, and *the entire house
layout is derived from it*. Every house-based statement then becomes wrong.

This single fact drives the `birthTimeReliability` factor and the Moon-sign
fallback.

### 2. Rashi (moon sign) — the resilient anchor

The sign the Moon occupied at birth. The Moon moves ~13° per day, so it stays in
one sign for about **2.25 days**.

**Why it matters:** a birth time wrong by *hours* usually leaves the moon sign
intact. When the ascendant can't be trusted, a real astrologer falls back to
Moon-sign reasoning. So does this engine.

> In India, "what's your sign?" conventionally means the **moon** sign, not the
> sun sign used in Western horoscopes. MyNaksh's marketing point about
> "personalised kundli, not generic sun-sign predictions" is exactly this
> distinction.

### 3. Bhava (houses) — twelve life areas

The twelve signs, counted from the lagna, become twelve houses. Each governs a
domain of life:

| House | Governs | Used for |
|---|---|---|
| 1 | Self, vitality, body, life direction | **health** (constitution) |
| 2 | Accumulated wealth, family, speech | **finance** |
| 3 | Courage, initiative, siblings | — |
| 4 | Home, mother, property, inner peace | — |
| 5 | Creativity, children, romance | **relationship** (romance) |
| 6 | **Daily work and service**, illness, debts, competition | **career**, **health** |
| 7 | Marriage, partnership | **relationship** |
| 8 | Transformation, sudden change, longevity | — |
| 9 | Fortune, mentors, higher learning | — |
| 10 | **Career, profession, status, reputation** | **career** |
| 11 | Income, gains, networks | **career**, **finance** |
| 12 | Expenditure, foreign lands, letting go | — |

**Three modelling decisions worth defending:**

- **Career is not only the 10th house.** The 10th is profession and public
  status; the **6th** is daily work and service — where an *employed job*
  actually sits; the **11th** is gains from it. The rule uses 10 as primary, 6
  and 11 as secondary.
- **Health is not only the 6th house.** The brief's example maps health → 6th,
  but the 6th is *illness*. The **1st** is the vitality that resists it, and the
  Moon governs the mind. All three are used.
- **The unused houses are unused deliberately** — 3, 4, 8, 9, 12 have no clean
  mapping to the five intents we support. Adding a `family` or `property` intent
  would bring 4 and 2 into play.

### 4. Graha (planets) and rulership

Nine bodies: Sun, Moon, Mars, Mercury, Jupiter, Venus, Saturn, plus the two
lunar nodes Rahu and Ketu.

Each sign has a fixed ruling planet:

```
Aries Mars      Taurus Venus     Gemini Mercury   Cancer Moon
Leo Sun         Virgo Mercury    Libra Venus      Scorpio Mars
Sagittarius Jup Capricorn Saturn Aquarius Saturn  Pisces Jupiter
```

**This is why chart validation is free.** House lords are *fully determined* by
the lagna:

```
Libra lagna → 10th house is Cancer → ruled by Moon
```

The brief's sample payload claims exactly that. It is internally consistent, and
we verify the property on every request. A mismatch means an upstream data bug.

> **Note:** these are the traditional seven planets plus two nodes. Uranus,
> Neptune and Pluto rule nothing in classical Jyotisha and are absent from the
> code — a deliberate correctness choice, not an omission.

---

## Vimshottari Dasha — the timing system

**The most important concept in the project.**

A person's life is divided into chapters, each ruled by one planet, in a fixed
120-year cycle:

| Lord | Years | | Lord | Years |
|---|---|---|---|---|
| Ketu | 7 | | Rahu | 18 |
| Venus | 20 | | Jupiter | 16 |
| Sun | 6 | | Saturn | 19 |
| Moon | 10 | | Mercury | 17 |
| Mars | 7 | | **Total** | **120** |

Fixed order: **Ketu → Venus → Sun → Moon → Mars → Rahu → Jupiter → Saturn →
Mercury →** (repeat).

- **Mahadasha** — the major period (6–20 years).
- **Antardasha** — sub-periods within it. Each mahadasha divides into nine
  antardashas, **starting with the mahadasha lord itself**, then continuing in
  the same cyclic order.
- Duration: `mahadashaYears × antardashaYears / 120`.

### The worked example that carries the whole project

The brief's own sample says `{"mahadasha": "Rahu", "antardasha": "Mars"}`.

```
Antardasha order within Rahu:
  Rahu → Jupiter → Saturn → Mercury → Ketu → Venus → Sun → Moon → Mars
    1       2         3         4       5      6      7      8     [9]

Mars is the 9th of 9 — the FINAL sub-period.
Duration: 18 × 7 / 120 = 1.05 years ≈ 12.6 months
```

**So this user is in the last year of an eighteen-year chapter, with a Jupiter
mahadasha beginning next.**

For the question *"should I change my job in the next few months?"* that is not
background colour — **it is the answer.** A chapter boundary is precisely when
endings and re-orientation are structurally expected.

And it is completely invisible in the raw JSON. Two strings that look like an
arbitrary pointer encode a life-stage transition. That is the single best
demonstration of why the derived-facts layer exists.

---

## Panchang — the daily almanac

Five limbs describing the quality of a given day. Unlike everything else here,
the panchang is about *today*, not about the person.

| Limb | What it is |
|---|---|
| **Tithi** | Lunar day (30 per lunar month, e.g. "Krishna Ekadashi") |
| **Nakshatra** | Which of 27 lunar mansions the Moon is transiting |
| **Yoga** | One of 27 sun–moon angular combinations |
| **Karana** | Half-tithi |
| *(Vara)* | Weekday — not in the given service |

**Two properties that drove design decisions:**

1. **The panchang day runs sunrise to sunrise**, not midnight to midnight. Hence
   the cache TTL expires at ~06:00 IST, not at midnight like the horoscope.
2. **It is location-dependent**, because sunrise is. The given
   `GET /panchang` endpoint takes no location parameter — a real limitation,
   flagged in the README rather than papered over.

### The nakshatra ↔ dasha bridge

The panchang is identical for every user in a location, which makes it the least
personal thing we hold. But:

**The 27 nakshatras cycle through the same nine dasha lords, three times over.**

```
Ashwini→Ketu  Bharani→Venus  Krittika→Sun  Rohini→Moon  Mrigashira→Mars
Ardra→Rahu    Punarvasu→Jup  Pushya→Sat    Ashlesha→Mer
Magha→Ketu    …repeats
```

So when the Moon transits a nakshatra ruled by *this user's own running dasha
lord*, a generic day becomes a personally charged one.

Observed live during development:

> Today's nakshatra is **Chitra**, ruled by **Mars** — which is also user_101's
> running antardasha lord.

That link is cheap to compute and is the difference between *"today is Chitra"*
and *"today's Chitra is ruled by Mars, which is running your current
sub-period."* It converts the least personal data source into a personalised one.

---

## Gochar — transits, and Sade Sati

Everything above is *fixed at birth* except the dasha pointer. The gochar is the
other moving part: where the planets are **now**, read against the natal chart.

Only the slow movers matter for this: Saturn takes about **2.5 years** to cross
a sign, Jupiter about **1 year**, Rahu and Ketu about **1.5 years**. The faster
planets change sign within days or weeks, and that rhythm is already in the
panchang (the nakshatra *is* the Moon's position). Slow transits are what can
characterise a month, a quarter or a year — which is exactly the horizon band
where the panchang has nothing to say. In the selection rules the two move in
opposite directions as the horizon widens: the almanac is dropped, the gochar
is promoted.

### Counted from the Moon, and why that matters here

Classical gochar counts a transiting planet's position **from the natal Moon
sign**, not from the lagna. That is not a stylistic detail for this engine: the
Moon sign survives a birth time that is wrong by hours, so **every Moon-relative
transit remains sound for a user whose houses have been suppressed**. `user_103`
has no birth time and no usable houses, and still gets a correct Sade Sati
reading. "Saturn is transiting your 6th house" needs the lagna and is never
built for that chart. Same sky, two facts, one sound.

### Sade Sati — the seven-and-a-half years

Saturn spends ~2.5 years in each of three consecutive signs: the one *before* the
Moon sign, the Moon sign itself, and the one *after*. That is Sade Sati
(*sāṛhe sātī*, "seven and a half"): three phases, ~7.5 years, and the single most
asked-about transit in India.

| Saturn is in the … from the Moon | Phase | Name |
|---|---|---|
| 12th | first | rising |
| 1st | second | peak |
| 2nd | third | setting |

Two shorter Saturn transits carry their own names: **Kantaka Shani** (4th from
the Moon) and **Ashtama Shani** (8th), each ~2.5 years, together called the
*dhaiya* or "small panoti". Saturn in the 3rd, 6th or 11th is classically easy.

The arithmetic, with `user_103` (Moon in Aquarius) and Saturn at 7° Pisces:

```
Pisces is the 2nd sign from Aquarius        -> setting phase (third of three)
7 / 30 degrees                               -> 23% through this phase
(1 - 0.23) x 29.5 months per sign            -> ~23 months of this phase left
phase index 2 x 30 + 7 = 67 of 90 degrees    -> 74% through the whole cycle
(1 - 0.744) x 3 x 29.5                       -> ~23 months of Sade Sati left
```

`29.5` is Saturn's orbital period (29.457 years) divided by twelve, in months.
It is a *mean* motion: real Saturn spends about a third of every year moving
backwards, so these are estimates and are worded as estimates.

### Jupiter and the nodes

Jupiter is read the same way. The classical supportive positions from the Moon
are the **2nd, 5th, 7th, 9th and 11th**; Jupiter over the 7th is the
marriage-timing transit, and Jupiter over the 2nd or 11th the money one. Its
dignity applies: exalted in Cancer, debilitated in Capricorn.

Rahu and Ketu are always exactly opposite each other and move **backwards**
through the zodiac — Rahu enters a sign at 30° and leaves at 0°. Forgetting this
inverts every "months remaining" figure, and there is a unit test whose only job
is to remember it.

### How the engine phrases it

Every transit statement ends the same way: *"a climate, not a verdict."* The
classical texts are blunt about Saturn, and a self-service product must not be.
The prompt's safety constraints say the same thing; the fact says it first, so
the model is never handed a raw "this is a bad period" to soften on its own.

---

## Dignity — how strong a planet is

A planet's strength depends on the sign it occupies:

| State | Meaning |
|---|---|
| **Exalted** (*uccha*) | Strongest placement |
| **Own sign** (*swakshetra*) | Comfortable |
| **Debilitated** (*neecha*) | Weakest |
| Neutral | Everything else |

```
Sun ↑Aries ↓Libra      Moon ↑Taurus ↓Scorpio    Mars ↑Capricorn ↓Cancer
Mercury ↑Virgo ↓Pisces Jupiter ↑Cancer ↓Capricorn
Venus ↑Pisces ↓Virgo   Saturn ↑Libra ↓Aries
```

**Rahu and Ketu are omitted** — their exaltation is genuinely disputed between
schools, so the code asserts nothing rather than pick a side. Worth saying if
asked: it demonstrates knowing where the domain is contested.

**A detail hiding in the sample data:** user_101 has a Libra lagna, making the
Moon the 10th (career) lord — and the Moon sits in Scorpio, where it is
*debilitated*. So the career lord is technically weak, while the payload reports
the 10th house as "Strong". The engine surfaces the placement and dignity, and
does not silently reconcile the tension.

---

## What we deliberately do NOT model

Being able to list these — and say why — matters more than having built them.

| Concept | What it is | Why not |
|---|---|---|
| ~~**Transits (gochar)**~~ | Where planets are *now* vs at birth | **Built** — see [Gochar](#gochar--transits-and-sade-sati). Needed a fifth, transit service that the brief did not provide; the bundled mock supplies one, propagated by mean motion. |
| **Divisional charts (D-10 etc.)** | Sub-charts for specific domains — D-10 is *the* career chart | Not in the given payload. A serious career reading would use it. |
| **Aspects (drishti)** | Planets influencing houses at a distance | Requires planetary positions; payload gives house lords only |
| **Yogas** | Named planetary combinations (Raj Yoga, Gaja Kesari) | Requires full positions; combinatorially large |
| **Ashtakavarga** | A numerical strength scoring system | Requires degrees |
| **Mangal Dosha / Kuja** | Mars affliction affecting marriage | Requires Mars's house placement, not just lordship |
| **Ashtakoot Guna Milan** | 36-point compatibility scoring | Needs two charts; no compatibility intent |

**The honest summary:** the natal payload gives house *lords* and *strength
labels*, not planetary *positions in degrees*. That ceiling is what limits the
depth of natal inference — and naming that ceiling precisely is a stronger
answer than listing techniques. The transit service is the one place the engine
now has degrees, and it uses them only for "how far through this sign".

---

## Ethical stance encoded in the product

Astrology in India is a mass-market consumer product used by people making real
decisions, sometimes while anxious or vulnerable. Three rules are enforced in
code, not merely requested in a prompt:

1. **No fatalism.** Never state a negative life event as certain. A dasha
   describes a *climate*, not a verdict. Enforced by deterministic softening:
   `"you will definitely"` → `"is likely to"`.
2. **Preserve agency.** The chart describes conditions; the user decides.
3. **Refuse what astrology must not answer.** Death timing, medical prognosis,
   prenatal sex (illegal in India), and requests to control another person.

These are simultaneously an ethics position, a product-quality position, and a
legal one — which is a good way to frame it if challenged.
