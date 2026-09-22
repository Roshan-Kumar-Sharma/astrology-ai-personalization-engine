import { Planet } from '../../astrology/zodiac';

/**
 * The planet(s) a question names outright.
 *
 * Intent says what area of life a question is about; horizon says over what
 * window. Neither can see that *"Is Sade Sati affecting me?"* is a question
 * about Saturn. It classifies as `general`, and on a free-tier budget the one
 * fact that answers it - Saturn's position from the Moon - lost a tie-break on
 * token count and was dropped. The golden eval found that on the first run.
 *
 * So this is a third signal read from the question text, in the same shape as
 * the horizon extractor: deterministic patterns, a named result, and a scoring
 * adjustment that shows up in the ledger with its reason. It does not change
 * intent. A question that names Saturn is still a career question if it is
 * about work; it just also gets Saturn's transit ranked where it can be seen.
 */
export interface FocusResult {
  planets: Planet[];
  /** "Gochar" / "transit" named without a planet - promote every slow mover. */
  gochar: boolean;
  /** Matched phrases, for the debug endpoint. */
  signals: string[];
}

const PLANET_RULES: { planet: Planet; patterns: RegExp[] }[] = [
  {
    planet: 'Saturn',
    patterns: [
      /\bsaturn\b/i,
      // "shani" but not "shanivar" (Saturday); the word boundary handles it.
      /\bshani\b/i,
      /\bsa+d?h?e\s?sa+t[ih]\b/i, // sade sati, saadhe saati, sadhe sati, sadesati
      /\bdhaiya\b/i,
      /\bpanoti\b/i,
      /\b(kantaka|ashtama)\s+shani\b/i,
      /शनि/,
      /साढ़े\s?साती/,
      /साढ़ेसाती/,
    ],
  },
  {
    planet: 'Jupiter',
    patterns: [
      /\bjupiter\b/i,
      /\bbrihaspati\b/i,
      // Bare "guru" is far more often the astrologer ("guru ji") or a teacher
      // than the planet, so only the compound forms count.
      /\bguru\s+(gochar|transit|grah|dev|bal|dasha|mahadasha)\b/i,
      /बृहस्पति/,
      /गुरु\s+(गोचर|ग्रह|दशा)/,
    ],
  },
  { planet: 'Rahu', patterns: [/\brahu\b/i, /राहु/] },
  { planet: 'Ketu', patterns: [/\bketu\b/i, /केतु/] },
];

const GOCHAR_PATTERNS = [/\bgochar\b/i, /\btransits?\b/i, /\btransiting\b/i, /गोचर/];

export function extractFocus(question: string): FocusResult {
  const planets: Planet[] = [];
  const signals: string[] = [];

  for (const rule of PLANET_RULES) {
    for (const pattern of rule.patterns) {
      const m = pattern.exec(question);
      if (m) {
        planets.push(rule.planet);
        signals.push(m[0]);
        break;
      }
    }
  }

  let gochar = false;
  for (const pattern of GOCHAR_PATTERNS) {
    const m = pattern.exec(question);
    if (m) {
      gochar = true;
      signals.push(m[0]);
      break;
    }
  }

  return { planets, gochar, signals };
}
