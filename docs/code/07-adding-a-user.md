# 7. Where User Data Comes From (and Adding a New User)

## The short answer

**`src/upstream/mock/fixtures.ts`** — three plain JavaScript objects keyed by
`userId`.

But that is only true in **local development**. In production the fixtures are
irrelevant: `UPSTREAM_*_URL` points at MyNaksh's real services and this file is
never touched.

---

## Following a `userId` through the system

```
POST /personalize  { "userId": "user_101", … }
        │
        ▼
PersonalizeController                     api/personalize.controller.ts
        │
        ▼
PersonalizeService.personalize()          api/personalize.service.ts
        │
        ▼
ContextAggregator.gather(userId)          upstream/context-aggregator.service.ts
        │   builds four paths from the id:
        │     /users/user_101
        │     /kundli/user_101
        │     /horoscope/user_101
        │     /panchang            ← note: NO userId, it is global
        ▼
UpstreamClient.fetch(source, baseUrl, path)   upstream/upstream.client.ts
        │   real HTTP GET to UPSTREAM_*_URL + path
        ▼
   ┌────┴─────────────────────────────────────┐
   │  DEV: http://127.0.0.1:4010              │
   │  PROD: https://kundli.mynaksh.internal   │
   └────┬─────────────────────────────────────┘
        ▼  (dev only)
mock-upstream.server.ts   →   regex extracts the id   →   fixtures.ts lookup
```

The key line in `context-aggregator.service.ts`:

```ts
this.client.fetch<UserProfile>('user', this.cfg.UPSTREAM_USER_URL, `/users/${userId}`, trace)
```

And in `mock-upstream.server.ts`:

```ts
const users = /^\/users\/([\w-]+)$/.exec(path);
if (users) {
  const user = USERS[users[1]];                 // ← the fixture lookup
  return user ? json(res, 200, user) : json(res, 404, { error: 'user not found' });
}
```

**Nothing in the application code knows fixtures exist.** It makes real HTTP
calls; the mock happens to be what answers them.

---

## What you must add for a new user

Three entries in `fixtures.ts`, all keyed by the same id:

| Map | Required? | If missing |
|-----|-----------|------------|
| `USERS` | **yes** | 404 → language/tone/tier fall back to defaults (English, neutral, free) |
| `KUNDLIS` | **yes** | 404 → no chart at all, confidence capped at `MEDIUM`, then `LOW` |
| `HOROSCOPES` | recommended | 404 → chart-only answer, lower confidence |
| `panchangFor()` | **no** | Global and date-derived — every user shares it |

A missing user does not crash anything. `user_999` returns `200` with
`confidence: LOW` and `sourcesUsed: []`.

---

## Worked example — `user_104`

### 1. `USERS`

```ts
user_104: {
  id: 'user_104',
  name: 'Sneha Kulkarni',
  language: 'mr',              // must exist in LANGUAGE_NAMES (style.config.ts)
  subscription: 'premium',     // 'free' | 'premium' — drives length + token budget
  tonePreference: 'direct',    // must exist in TONE_ALIASES
  birthDetails: {
    date: '1989-06-11',
    time: '04:22',             // omit entirely to test the unknown-time path
    place: 'Nagpur',
    timeAccuracy: 'exact',     // optional — inferred if absent
  },
},
```

### 2. `KUNDLIS` — the part that needs care

**The house lords must match the lagna, or the engine will reject the chart.**

Derive them with `lordOfHouse(lagna, house)` from `astrology/zodiac.ts`:

```
signOfHouse(lagna, house) = SIGNS[(lagnaIndex + house - 1) % 12]
SIGN_LORD[thatSign]       = the lord
```

For a **Capricorn** lagna (index 9):

| House | Sign | Lord |
|-------|------|------|
| 1 | Capricorn | Saturn |
| 2 | Aquarius | Saturn |
| 5 | Taurus | Venus |
| 6 | Gemini | Mercury |
| 7 | Cancer | Moon |
| 10 | Libra | **Venus** |
| 11 | Scorpio | Mars |

```ts
user_104: {
  lagna: 'Capricorn',
  moonSign: 'Virgo',
  currentDasha: { mahadasha: 'Mercury', antardasha: 'Ketu' },
  houses: {
    '1':  { lord: 'Saturn',  strength: 'Strong'  },
    '2':  { lord: 'Saturn',  strength: 'Average' },
    '5':  { lord: 'Venus',   strength: 'Strong'  },
    '6':  { lord: 'Mercury', strength: 'Strong'  },
    '7':  { lord: 'Moon',    strength: 'Average' },
    '10': { lord: 'Venus',   strength: 'Strong'  },
    '11': { lord: 'Mars',    strength: 'Average' },
  },
},
```

`currentDasha` must use two of the nine dasha lords: **Ketu, Venus, Sun, Moon,
Mars, Rahu, Jupiter, Saturn, Mercury**. Anything else and `locateDasha()` returns
`undefined`, silently producing no dasha facts.

`strength` is a free-text label from upstream — `'Strong' | 'Average' | 'Weak'`.
It is **not** validated, only reported.

### 3. `HOROSCOPES`

```ts
user_104: {
  career: 'A long-running project moves closer to completion.',
  finance: 'A good week to renegotiate a recurring cost.',
  health: 'Your stamina responds well to an earlier bedtime.',
  relationship: 'Someone close appreciates being asked, not assumed.',
},
```

All four keys are required by the `Horoscope` type.

---

## Verifying it worked

```bash
npm run build && npm start
```

```bash
curl -s -X POST localhost:3000/debug/personalization \
  -H 'content-type: application/json' \
  -d '{"userId":"user_104","question":"Should I change my job in the next few months?"}' \
  | python3 -m json.tool
```

Check three things in `explain`:

```
chartReliability.inconsistencies : []        ← chart is astrologically valid
chartReliability.housesUsable    : true
projectedConfidence.label        : HIGH
```

And confirm the dasha maths ran:

```
Mercury mahadasha (17 years), currently the 2nd of nine sub-periods:
Ketu antardasha, about 11.9 months long. This places the user roughly
14.2-20% through the Mercury chapter (early phase).
```

`17 × 7 / 120 = 0.99 years = 11.9 months` — computed, not stored.

---

## What happens if you get the chart wrong

This is worth doing once, deliberately. Change the 10th lord to `Jupiter`
(Capricorn lagna makes it Venus) and rerun:

```
inconsistencies : House 10 lord is "Jupiter" but a Capricorn lagna makes it Venus.
housesUsable    : false          ← ALL house context suppressed
confidence      : MEDIUM (0.6)
caps            : Chart failed consistency validation: House 10 lord is "Jupiter"…
                  Birth time cannot support house division; reasoning limited to
                  the Moon sign and the running dasha.
```

**One wrong lord disables every house-based statement in the answer.** That is
`assessChart()` in `astrology/chart-validation.ts` doing its job — the same check
that would catch a real upstream data bug in production.

---

## Deliberately testing the degraded paths

The fixture set exists to exercise different code paths, not to look realistic:

| Setup | Path exercised |
|-------|----------------|
| Omit `time` from `birthDetails` | Houses suppressed, Moon-sign fallback, `MEDIUM` cap |
| `time: '09:00'`, no `timeAccuracy` | Heuristic marks it `approximate` |
| `subscription: 'free'` | 320-token budget instead of 900, shorter answer |
| `language: 'hinglish'` | Latin-script Hindi output |
| Wrong house lord | Chart validation failure |
| No fixture at all | Full upstream failure, `LOW` confidence, still `200` |

---

## Adding a new *language* or *tone*

Neither lives in the fixtures. Both are in
`personalization/config/style.config.ts`:

```ts
export const LANGUAGE_NAMES = { en: 'English', hi: 'Hindi', mr: 'Marathi', … };
export const LANGUAGE_DIRECTIVES = { mr: 'Write in natural conversational Marathi using Devanagari script.', … };

export const TONE_DIRECTIVES: Record<Tone, string> = { direct: 'Concise and plain-spoken…', … };
export const TONE_ALIASES = { direct: 'direct', blunt: 'direct', concise: 'direct', … };
```

An unrecognised language falls back to English; an unrecognised tone falls back
to neutral. Neither errors — a user profile from upstream must never be able to
crash the service.

> **Lesson learned:** a language directive that only *describes* the register is
> not enough. The Hinglish one originally said "Hindi written in Latin script"
> and the model returned plain English. Adding a one-line exemplar to the
> directive fixed it.

---

## In production, none of this applies

```bash
MOCK_UPSTREAM_ENABLED=false
UPSTREAM_USER_URL=https://users.mynaksh.internal
UPSTREAM_KUNDLI_URL=https://kundli.mynaksh.internal
UPSTREAM_HOROSCOPE_URL=https://horoscope.mynaksh.internal
UPSTREAM_PANCHANG_URL=https://panchang.mynaksh.internal
```

No code changes. The four base URLs are independent, so services can live on
different hosts. `fixtures.ts` and `mock-upstream.server.ts` are never loaded.

The only real requirement is that the responses match the interfaces in
`upstream/types.ts` — which are exactly the shapes given in the brief.
