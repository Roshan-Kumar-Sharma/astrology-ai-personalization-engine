# 3. Astrology — `src/astrology/`

The domain core. **No NestJS imports, no I/O, no LLM.** Every rule here is a pure
function, which is why all of it is unit-testable and why it would port to
another language in about an hour.

---

## `zodiac.ts` — reference tables

### Signs and rulership

```ts
export const SIGNS = ['Aries','Taurus','Gemini','Cancer','Leo','Virgo',
                      'Libra','Scorpio','Sagittarius','Capricorn','Aquarius','Pisces'] as const;
export type Sign = (typeof SIGNS)[number];
```

`as const` freezes the array into a literal tuple, so `Sign` becomes the union
`'Aries' | 'Taurus' | …` rather than plain `string`. Typos fail to compile.

```ts
export const SIGN_LORD: Record<Sign, Planet> = {
  Aries: 'Mars',   Taurus: 'Venus',  Gemini: 'Mercury',  Cancer: 'Moon',
  Leo: 'Sun',      Virgo: 'Mercury', Libra: 'Venus',     Scorpio: 'Mars',
  Sagittarius: 'Jupiter', Capricorn: 'Saturn', Aquarius: 'Saturn', Pisces: 'Jupiter',
};
```

`Record<Sign, Planet>` makes this **exhaustive by construction** — omit a sign and
it does not compile. Two planets rule two signs each; the Sun and Moon rule one.
Uranus, Neptune and Pluto are absent: they rule nothing in classical Jyotisha.

### `houseOfSign()` — the arithmetic behind everything

```ts
export function houseOfSign(lagna: string, sign: string): number | undefined {
  const l = signIndex(lagna);
  const s = signIndex(sign);
  if (l < 0 || s < 0) return undefined;
  return ((s - l + 12) % 12) + 1;
}
```

Houses are counted **from the lagna**, wrapping around the zodiac.

Worked example — Libra lagna, where does Scorpio fall?
```
signIndex('Libra')   = 6
signIndex('Scorpio') = 7
((7 - 6 + 12) % 12) + 1 = (13 % 12) + 1 = 1 + 1 = 2      → 2nd house
```

The `+ 12` handles wrap-around. For Pisces (index 11) with an Aries lagna
(index 0): `((11 - 0 + 12) % 12) + 1 = 12` — the 12th house. Without `+ 12`, a
sign *before* the lagna would give a negative modulo.

The `+ 1` converts 0-indexed maths to 1-indexed houses, because astrologers count
from one.

### `signOfHouse()` and `lordOfHouse()` — the inverse

```ts
export function signOfHouse(lagna: string, house: number): Sign | undefined {
  const l = signIndex(lagna);
  if (l < 0 || house < 1 || house > 12) return undefined;
  return SIGNS[(l + house - 1) % 12];
}

export function lordOfHouse(lagna: string, house: number): Planet | undefined {
  const sign = signOfHouse(lagna, house);
  return sign ? SIGN_LORD[sign] : undefined;
}
```

`lordOfHouse('Libra', 10)`:
```
signOfHouse → SIGNS[(6 + 10 - 1) % 12] = SIGNS[15 % 12] = SIGNS[3] = 'Cancer'
SIGN_LORD['Cancer'] = 'Moon'
```

**This two-line function is what makes chart validation free.** The lagna fully
determines every house lord, so we can check the upstream's claims against it on
every request.

### Dignity

```ts
export function dignityOf(planet: Planet, sign: Sign): Dignity {
  if (EXALTATION[planet] === sign) return 'exalted';
  if (DEBILITATION[planet] === sign) return 'debilitated';
  if (ownsSign(planet, sign)) return 'own sign';
  return 'neutral';
}
```

Order matters — exaltation is checked before own-sign because a planet could
theoretically satisfy both, and exaltation is the stronger statement.

`EXALTATION` and `DEBILITATION` are `Partial<Record<Planet, Sign>>` — **partial**
because Rahu and Ketu are deliberately omitted. Their exaltation is genuinely
disputed between schools, so the code asserts nothing rather than pick a side.

### `normalizeSign()` — accepting Sanskrit names

```ts
export function normalizeSign(sign: string): string {
  const t = sign.trim().toLowerCase();
  const found = SIGNS.find((s) => s.toLowerCase() === t);
  if (found) return found;
  return RASHI_ALIASES[t] ?? sign;
}
```

An upstream might send `"Tula"` or `"Mesha"` instead of `"Libra"` or `"Aries"`.
Falls back to returning the input unchanged, so `signIndex` reports `-1` and the
validator flags it rather than crashing.

---

## `vimshottari.ts` — the timing system

The most domain-specific file, and the one that produces the project's strongest
insight.

### The fixed constants

```ts
export const DASHA_SEQUENCE: Planet[] = ['Ketu','Venus','Sun','Moon','Mars','Rahu','Jupiter','Saturn','Mercury'];

export const DASHA_YEARS: Record<Planet, number> = {
  Ketu: 7, Venus: 20, Sun: 6, Moon: 10, Mars: 7,
  Rahu: 18, Jupiter: 16, Saturn: 19, Mercury: 17,
};

export const TOTAL_CYCLE_YEARS = 120;
```

These are **not tunable** — they are the definition of the Vimshottari system.
The years sum to exactly 120, which a test asserts:

```ts
const total = DASHA_SEQUENCE.reduce((s, p) => s + DASHA_YEARS[p], 0);
expect(total).toBe(TOTAL_CYCLE_YEARS);
```

### `antardashaSequence()`

```ts
export function antardashaSequence(mahadasha: Planet): Planet[] {
  const start = DASHA_SEQUENCE.indexOf(mahadasha);
  return Array.from({ length: 9 }, (_, i) => DASHA_SEQUENCE[(start + i) % 9]);
}
```

Sub-periods run in the **same cyclic order, starting with the mahadasha lord
itself**. `% 9` wraps around the end of the list.

```
antardashaSequence('Rahu')
Rahu is at index 5.
i=0 → (5+0)%9 = 5 → Rahu
i=1 → (5+1)%9 = 6 → Jupiter
i=2 → 7 → Saturn      i=3 → 8 → Mercury
i=4 → (5+4)%9 = 0 → Ketu      ← wraps here
i=5 → 1 → Venus       i=6 → 2 → Sun
i=7 → 3 → Moon        i=8 → 4 → Mars
```

### `antardashaYears()`

```ts
export function antardashaYears(mahadasha: Planet, antardasha: Planet): number {
  return (DASHA_YEARS[mahadasha] * DASHA_YEARS[antardasha]) / TOTAL_CYCLE_YEARS;
}
```

Each sub-period takes a share of the chapter proportional to its own weight in
the 120-year cycle.

```
Rahu (18) × Mars (7) / 120 = 1.05 years = 12.6 months
```

A test verifies the sub-periods of every mahadasha sum back to its full length —
a strong invariant that would catch any arithmetic slip.

### `locateDasha()` — the payoff function

```ts
export function locateDasha(mahadashaRaw: string, antardashaRaw: string): DashaPosition | undefined {
  const mahadasha = normalizePlanet(mahadashaRaw);
  const antardasha = normalizePlanet(antardashaRaw);
  if (!mahadasha || !antardasha) return undefined;

  const seq = antardashaSequence(mahadasha);
  const idx = seq.indexOf(antardasha);
  if (idx < 0) return undefined;
```

Returns `undefined` rather than throwing on bad input — the caller treats a
missing position as "no dasha facts", which degrades gracefully.

```ts
  const mdYears = DASHA_YEARS[mahadasha];
  const elapsedBefore = seq.slice(0, idx)
    .reduce((sum, p) => sum + antardashaYears(mahadasha, p), 0);
  const currentYears = antardashaYears(mahadasha, antardasha);
```

`elapsedBefore` sums every sub-period **before** this one — that is how far into
the chapter the current sub-period begins.

```ts
  const fromPct = round1((elapsedBefore / mdYears) * 100);
  const toPct   = round1(((elapsedBefore + currentYears) / mdYears) * 100);
```

**A range, not a point.** The upstream gives no dates — we know *which*
sub-period, not how far into it. Reporting `94.2–100%` is honest; reporting
`97.1%` would be invented precision.

```ts
  return {
    mahadasha, antardasha, mahadashaYears: mdYears,
    antardashaMonths: round1(currentYears * 12),
    antardashaIndex: idx + 1,
    isFinalAntardasha: idx === 8,
    isOpeningAntardasha: idx === 0,
    nextMahadasha: DASHA_SEQUENCE[(DASHA_SEQUENCE.indexOf(mahadasha) + 1) % 9],
    nextAntardasha: idx < 8 ? seq[idx + 1] : undefined,
    chapterProgress: { fromPct, toPct },
    phase: idx === 0 ? 'opening' : idx === 8 ? 'closing'
         : midPct < 35 ? 'early' : midPct < 70 ? 'middle' : 'late',
  };
}
```

`isFinalAntardasha: idx === 8` is the flag that produces the whole "chapter
boundary" insight — index 8 is the ninth and last sub-period.

**The full worked example, for `locateDasha('Rahu', 'Mars')`:**
```
seq          = [Rahu, Jupiter, Saturn, Mercury, Ketu, Venus, Sun, Moon, Mars]
idx          = 8                                          → the 9th of 9
mdYears      = 18
elapsedBefore= 18×(18+16+19+17+7+20+6+10)/120 = 16.95 years
currentYears = 18×7/120 = 1.05 years → 12.6 months
fromPct      = 16.95/18 = 94.2%
toPct        = 18.00/18 = 100%
isFinal      = true      phase = 'closing'      nextMahadasha = 'Jupiter'
```

### `nakshatraLord()`

```ts
export function nakshatraLord(nakshatra: string): Planet | undefined {
  const i = NAKSHATRAS.findIndex((n) => n.toLowerCase() === nakshatra.trim().toLowerCase());
  return i < 0 ? undefined : DASHA_SEQUENCE[i % 9];
}
```

27 nakshatras, 9 dasha lords, so the lords repeat exactly three times.
`i % 9` is the whole rule. This one line is what lets us connect today's panchang
to a specific user's running dasha.

---

## `gochar.ts` — transits

Pure functions again, in the shape of `vimshottari.ts`. The whole file counts
signs from the natal Moon and reads a degree within a sign as "how far
through".

### `signsFrom()` and `signProgress()`

```ts
export function signsFrom(from, to) { return ((b - a + 12) % 12) + 1; }   // inclusive: the sign itself is 1

export function signProgress(planet, degree) {
  const retrogradeNode = planet === 'Rahu' || planet === 'Ketu';
  const fraction = retrogradeNode ? (30 - d) / 30 : d / 30;
  return { pct, monthsRemaining: (1 - fraction) * MONTHS_PER_SIGN[planet] };
}
```

`MONTHS_PER_SIGN` is each orbital period over twelve: Saturn 29.457 y → 29.5
months, Jupiter 11.862 y → 11.9, the nodes 18.613 y → 18.6. The `retrogradeNode`
branch is the one line most likely to be wrong in a gochar implementation: Rahu
enters a sign at 30° and *leaves* at 0°, so Rahu at 4° is nearly out, not nearly
in. Its test says exactly that.

### `saturnFromMoon()` — Sade Sati

```ts
const SADE_SATI_PHASE = { 12: 'rising', 1: 'peak', 2: 'setting' };
if (phase) {
  const elapsedDeg = SADE_SATI_PHASE_INDEX[phase] * 30 + degree;   // 0..90
  cycle = { pct: elapsedDeg / 90, monthsRemaining: (1 - pct) * 3 * MONTHS_PER_SIGN.Saturn };
}
if (fromMoon === 4) kind = 'dhaiya', dhaiyaName = 'Kantaka Shani';
if (fromMoon === 8) kind = 'dhaiya', dhaiyaName = 'Ashtama Shani';
favourable = [3, 6, 11].includes(fromMoon);
```

Worked: Moon in Aquarius, Saturn at 7° Pisces → `fromMoon = 2` → setting
phase; `elapsedDeg = 2 × 30 + 7 = 67` → 74.4% of the cycle; `(1 − 0.744) × 88.5
= 22.6` months left. The unit test pins those exact numbers.

`jupiterFromMoon()` (supportive in 2/5/7/9/11, plus dignity) and
`nodesFromMoon()` (Ketu always `rahu + 6`) follow the same pattern.

---

## `chart-validation.ts`

### `assessChart()`

```ts
for (const [houseNo, info] of Object.entries(kundli.houses ?? {})) {
  const house = Number(houseNo);
  const expected = lordOfHouse(kundli.lagna, house);
  if (!expected) continue;
  if (expected !== info.lord) {
    inconsistencies.push(
      `House ${house} lord is "${info.lord}" but a ${kundli.lagna} lagna makes it ${expected}.`,
    );
  }
}
```

Because `lordOfHouse` derives the truth from the lagna, we can check the
upstream's claim for free on every request. A mismatch means an upstream data bug
— a bad ephemeris config or a swapped mapping produces a payload that is
syntactically perfect and astrologically impossible.

We **flag** rather than override: the upstream is the system of record, so we
report the contradiction and lower confidence instead of silently substituting
our own value.

```ts
const housesUsable = birthTime !== 'unknown' && inconsistencies.length === 0;
```

Two independent reasons to distrust houses: an unusable birth time, or a chart
that failed validation. Either one suppresses all house-based reasoning.

### `assessBirthTime()`

```ts
export function assessBirthTime(user: UserProfile | undefined): BirthTimeReliability {
  const details = user?.birthDetails;
  if (!details?.time) return 'unknown';
  if (details.timeAccuracy) return details.timeAccuracy;

  const [, minutes] = details.time.split(':').map(Number);
  if (Number.isNaN(minutes)) return 'unknown';
  return minutes % 30 === 0 ? 'approximate' : 'exact';
}
```

Precedence: no time → `unknown`; explicit flag → trust it; otherwise **infer**.

The heuristic: a time landing exactly on the hour or half hour (`09:00`, `18:30`)
is far more likely a remembered approximation than a recorded fact. `09:35` reads
as genuinely recorded.

This is a *heuristic*, and it will be wrong sometimes — someone genuinely born at
09:00 gets marked approximate. The cost of that error (slightly lower confidence)
is much smaller than the reverse (house claims stated with false certainty).

---

## `inference.service.ts` — raw data to conclusions

The largest domain file. `derive()` orchestrates, private methods do the work.

### `derive()`

```ts
derive(input): { facts: DerivedFact[]; reliability: ChartReliability } {
  const { user, kundli, panchang, categories } = input;
  const reliability = assessChart(kundli, user);
  const facts: DerivedFact[] = [];

  if (!kundli) return { facts, reliability };

  facts.push(...this.dashaFacts(kundli, categories, reliability));

  if (reliability.housesUsable) {
    facts.push(...this.houseFacts(kundli, categories));
    facts.push(...this.moonPlacementFacts(kundli));
  } else {
    facts.push(...this.moonSignFallbackFacts(kundli, reliability));
  }

  if (panchang) facts.push(...this.panchangResonanceFacts(kundli, panchang));

  return { facts, reliability };
}
```

The `if/else` is the **Moon-sign fallback made concrete**: when houses are
unusable we do not merely skip house facts, we substitute a different kind of
reasoning. That is what a real astrologer does.

### `dashaFacts()` — the house-rulership bridge

```ts
if (reliability.housesUsable) {
  const ruled = this.housesRuledBy(kundli.lagna, pos.antardasha);
  const relevant = ruled.filter((h) => categories.some((c) => HOUSES_FOR_CATEGORY[c].includes(h)));
  const houseList = relevant.length ? relevant : ruled;
  if (houseList.length) {
    out.push({
      id: 'derived.dasha.house_rulership',
      statement: `In this chart the sub-period lord ${pos.antardasha} rules ` +
        houseList.map((h) => `house ${h} (${HOUSE_MEANING[h]})`).join(' and ') +
        `, so those areas are the ones this sub-period actually activates.`,
      // …
    });
  }
}
```

**This is what makes the reading personal rather than generic.** "A Mars period"
is true for everyone in a Mars period. "A Mars period, and in *your* chart Mars
rules the 2nd house of income" is true only for this user.

The `relevant.length ? relevant : ruled` fallback: prefer houses matching the
question's categories, but if the sub-period lord rules nothing relevant, report
what it does rule rather than saying nothing.

```ts
private housesRuledBy(lagna: string, planet: Planet): number[] {
  if (planet === 'Rahu' || planet === 'Ketu') return [];
  const houses: number[] = [];
  for (let h = 1; h <= 12; h++) if (lordOfHouse(lagna, h) === planet) houses.push(h);
  return houses;
}
```

The early return for the nodes is a domain rule, not a shortcut — Rahu and Ketu
rule no signs classically, so they own no houses.

### `panchangResonanceFacts()` — the global-to-personal bridge

```ts
const lord = nakshatraLord(panchang.nakshatra ?? '');
if (!lord) return [];

const md = normalizePlanet(kundli.currentDasha?.mahadasha ?? '');
const ad = normalizePlanet(kundli.currentDasha?.antardasha ?? '');
const matches = [md === lord ? 'mahadasha' : null, ad === lord ? 'antardasha' : null].filter(Boolean);

if (!matches.length) {
  return [{ id: 'derived.panchang.lord', /* generic statement */ }];
}

return [{
  id: 'derived.panchang.resonance',
  statement: `Today's nakshatra ${panchang.nakshatra} is ruled by ${lord}, which is also the user's ` +
             `running ${matches.join(' and ')} lord. Days like this tend to bring the themes of the ` +
             `current period to the surface, so today is unusually relevant to the question.`,
  // …
}];
```

The panchang is identical for every user in a location — the least personal thing
we hold. But when today's nakshatra lord matches *this user's* running dasha
lord, a generic day becomes personally charged.

Observed live: today's nakshatra Chitra is ruled by Mars, which is user_101's
running antardasha lord — so `derived.panchang.resonance` fired instead of the
generic `derived.panchang.lord`.

### `transitFromMoonFacts()` and `transitOverHouseFacts()`

Two methods, deliberately separate, because they have different reliability:

```ts
if (transits) {
  facts.push(...this.transitFromMoonFacts(kundli, transits));
  if (reliability.housesUsable) facts.push(...this.transitOverHouseFacts(kundli, transits));
}
```

The Moon-relative facts (`derived.transit.sade_sati` | `dhaiya` | `saturn`,
`derived.transit.jupiter`, `derived.transit.nodes`) need only `kundli.moonSign`
and survive an unknown birth time. The house-relative ones
(`derived.transit.saturn.house.6`, `derived.transit.jupiter.house.10`) need the
lagna and follow the same rule as every other house statement: not built at all
when houses are unsound. The selector's reliability gate would catch them by id
anyway — `/\.house\.\d+$/` matches — and a test proves it; not building them is
the belt to that brace.

Exactly one Saturn fact is emitted per chart, whichever of the three applies.
Every statement ends *"a climate, not a verdict"*, and every one is terse on
purpose: the first draft cost 197 tokens across three facts and pushed the
career horoscope out of a free-tier answer. The golden eval caught it.

### `DerivedFact` and provenance

```ts
export interface DerivedFact {
  id: string;
  label: string;
  categories: DomainCategory[];
  statement: string;
  confidence: FactConfidence;
  basis: string[];     // ← which raw fields produced this
}
```

`basis` records provenance: `['kundli.currentDasha', 'kundli.lagna']`. That is
what lets a reviewer trace any generated claim back to a specific upstream field.

### `HOUSES_FOR_CATEGORY`

```ts
export const HOUSES_FOR_CATEGORY: Record<DomainCategory, number[]> = {
  career:       [10, 6, 11],
  relationship: [7, 5, 2],
  health:       [1, 6, 8],
  finance:      [2, 11, 5],
  self:         [1, 9],
  timing:       [],
  general:      [1, 10, 7],
};
```

Small table, real domain content. `health: [1, 6, 8]` includes the **1st** house
because that is vitality — the brief's example mapped health to the 6th alone,
which is *illness*, not health. `career: [10, 6, 11]` includes the **6th** because
that is where employed work actually sits.
