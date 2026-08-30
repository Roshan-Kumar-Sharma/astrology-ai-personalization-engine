import { Horizon } from '../types';

/**
 * Extracts the temporal scope of a question.
 *
 * Ordered most-specific-first: "next few months" must win over the bare "month"
 * inside it, so the patterns are evaluated in sequence rather than scored.
 */
const RULES: { horizon: Horizon; patterns: RegExp[] }[] = [
  {
    horizon: 'lifetime',
    patterns: [
      /\b(ever|in\s+my\s+life(time)?|life\s?long|at\s+all|some\s?day|one\s+day)\b/i,
      /\bwill\s+i\s+ever\b/i,
      /\bkabhi\b/i,
    ],
  },
  {
    horizon: 'quarter',
    patterns: [
      /\bnext\s+(few|couple\s+of|2|3|4|5|6|two|three|four|five|six)\s+months?\b/i,
      /\bcoming\s+months?\b/i,
      /\b(this|next)\s+quarter\b/i,
      /\b(3|4|5|6|three|four|five|six)\s+months?\b/i,
      /\bagle\s+(kuch\s+)?maheen?o?n?\b/i,
    ],
  },
  {
    horizon: 'year',
    patterns: [
      /\b(this|next|coming)\s+year\b/i,
      /\b(in|during)\s+20\d\d\b/i,
      /\b12\s+months?\b/i,
      /\bsaal\b/i,
      /\bis\s+saal\b/i,
    ],
  },
  {
    horizon: 'month',
    patterns: [
      /\b(this|next|coming)\s+month\b/i,
      /\b30\s+days?\b/i,
      /\b(is|agle)\s+mah?een?e\b/i,
      /\bmahine\b/i,
    ],
  },
  {
    horizon: 'week',
    patterns: [
      /\b(this|next|coming)\s+week\b/i,
      /\bnext\s+(few|couple\s+of)\s+days\b/i,
      /\b7\s+days?\b/i,
      /\b(is|agle)\s+haft?e\b/i,
    ],
  },
  {
    horizon: 'today',
    patterns: [
      /\b(today|tonight|right\s+now|at\s+the\s+moment|currently|this\s+morning|this\s+evening)\b/i,
      /\btoday'?s\b/i,
      /\btomorrow\b/i,
      /\b(aaj|abhi)\b/i,
      /आज|अभी/,
    ],
  },
];

export function extractHorizon(question: string): { horizon: Horizon; signal?: string } {
  const q = question.normalize('NFKC');
  for (const rule of RULES) {
    for (const re of rule.patterns) {
      const m = re.exec(q);
      if (m) return { horizon: rule.horizon, signal: m[0].trim() };
    }
  }
  return { horizon: 'unspecified' };
}
