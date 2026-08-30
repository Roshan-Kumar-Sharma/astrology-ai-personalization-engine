import { Injectable } from '@nestjs/common';
import { SIGNS } from '../astrology/zodiac';
import { ScoredItem } from '../personalization/types';

export interface ParsedModelOutput {
  answer: string;
  citedIds: string[];
  /** True when the model ignored the JSON contract and we fell back to raw text. */
  usedFallbackParse: boolean;
}

export interface GroundednessReport {
  /** Ids the model cited that were genuinely in the context we sent. */
  verifiedIds: string[];
  /** Ids the model cited that we never sent. */
  fabricatedIds: string[];
  /** Astrological entities named in the answer but absent from the context. */
  ungroundedEntities: string[];
  /**
   * True when the model ignored the JSON output contract and we recovered the
   * answer as raw text. It is not merely cosmetic: without the citation list we
   * cannot verify what the answer rests on, so confidence must reflect that.
   */
  contractIgnored: boolean;
  /** 0-1 score folded into the response confidence. */
  score: number;
}

const PLANETS = ['sun', 'moon', 'mars', 'mercury', 'jupiter', 'venus', 'saturn', 'rahu', 'ketu'];

const ORDINAL_WORDS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
  eleventh: 11,
  twelfth: 12,
};

/**
 * Verifies that the generated answer is actually supported by the context we
 * sent, rather than trusting the model's own account of what it used.
 *
 * This matters more in astrology than in most domains. A fluent, confident
 * sentence about "your strong Venus" is indistinguishable from a correct one to
 * a reader who cannot check, and Venus may never have been in the prompt at all.
 * The check is cheap: everything we sent is known exactly, so any planet, sign
 * or house named in the answer but absent from the context is, by construction,
 * invented.
 *
 * The output also produces the response's `sourcesUsed`. Deriving that from
 * verified citations rather than from the selection list means the field
 * describes what the answer actually rests on.
 */
@Injectable()
export class GroundednessService {
  /** Defensive parse: a provider that ignores the JSON contract must degrade. */
  parse(raw: string): ParsedModelOutput {
    const trimmed = stripReasoning(raw).trim();
    const jsonText = extractJsonObject(trimmed);

    if (jsonText) {
      try {
        const obj = JSON.parse(jsonText) as { answer?: unknown; usedContextIds?: unknown };
        if (typeof obj.answer === 'string' && obj.answer.trim()) {
          return {
            answer: obj.answer.trim(),
            citedIds: Array.isArray(obj.usedContextIds)
              ? obj.usedContextIds.filter((i): i is string => typeof i === 'string')
              : [],
            usedFallbackParse: false,
          };
        }
      } catch {
        // fall through to raw-text handling
      }
    }

    return { answer: trimmed, citedIds: [], usedFallbackParse: true };
  }

  verify(parsed: ParsedModelOutput, selected: ScoredItem[]): GroundednessReport {
    const selectedIds = new Set(selected.map((i) => i.id));
    const verifiedIds = parsed.citedIds.filter((id) => selectedIds.has(id));
    const fabricatedIds = parsed.citedIds.filter((id) => !selectedIds.has(id));

    // Everything the model was allowed to know, lowercased for containment.
    const vocabulary = selected
      .map((i) => `${i.label} ${i.text}`)
      .join(' ')
      .toLowerCase();

    const answer = parsed.answer.toLowerCase();
    const ungrounded: string[] = [];

    for (const planet of PLANETS) {
      if (new RegExp(`\\b${planet}\\b`).test(answer) && !vocabulary.includes(planet)) {
        ungrounded.push(planet);
      }
    }

    for (const sign of SIGNS) {
      const s = sign.toLowerCase();
      if (new RegExp(`\\b${s}\\b`).test(answer) && !vocabulary.includes(s)) {
        ungrounded.push(sign);
      }
    }

    for (const house of housesMentioned(answer)) {
      const inContext =
        selected.some((i) => i.id.endsWith(`.house.${house}`)) ||
        new RegExp(`house ${house}\\b`).test(vocabulary);
      if (!inContext) ungrounded.push(`house ${house}`);
    }

    // Fabricated citations are a weaker signal than invented entities: a model
    // may cite sloppily while still reasoning only from what it was given.
    // An ignored output contract is worse than either, because it removes our
    // ability to check at all.
    const penalty = Math.min(
      1,
      ungrounded.length * 0.3 + fabricatedIds.length * 0.1 + (parsed.usedFallbackParse ? 0.35 : 0),
    );

    return {
      verifiedIds,
      fabricatedIds,
      ungroundedEntities: [...new Set(ungrounded)],
      contractIgnored: parsed.usedFallbackParse,
      score: Math.round((1 - penalty) * 100) / 100,
    };
  }

  /**
   * The user-facing `sourcesUsed` list.
   *
   * Prefers what the model verifiably cited. When it cited nothing usable (a
   * provider that ignored the JSON contract, or a fallback parse), falls back to
   * the highest-ranked context we sent, which is the best available account of
   * what the answer rests on.
   */
  sourcesUsed(report: GroundednessReport, selected: ScoredItem[], fallbackCount = 3): string[] {
    const byId = new Map(selected.map((i) => [i.id, i]));
    const chosen = report.verifiedIds.length
      ? report.verifiedIds.map((id) => byId.get(id)).filter(isDefined)
      : [...selected].sort((a, b) => b.score - a.score).slice(0, fallbackCount);

    // Panchang limbs collapse to a single "Today's Panchang" for the reader.
    return [...new Set(chosen.map((i) => i.displayGroup ?? i.label))];
  }
}

function housesMentioned(answer: string): number[] {
  const found = new Set<number>();
  for (const m of answer.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)\s+house\b/g)) {
    found.add(Number(m[1]));
  }
  for (const m of answer.matchAll(/\bhouse\s+(\d{1,2})\b/g)) {
    found.add(Number(m[1]));
  }
  for (const [word, n] of Object.entries(ORDINAL_WORDS)) {
    if (new RegExp(`\\b${word}\\s+house\\b`).test(answer)) found.add(n);
  }
  return [...found].filter((n) => n >= 1 && n <= 12);
}

/**
 * Removes visible chain-of-thought.
 *
 * A large share of the models on free tiers are reasoning models, and several
 * emit their thinking as ordinary content rather than in a separate field. Left
 * in, it reaches the user as the answer.
 */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
    .replace(/^[\s\S]*?<\/think>/i, '');
}

/** Finds the outermost JSON object, tolerating markdown fences and preamble. */
function extractJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fenced ? fenced[1].trim() : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  return candidate.slice(start, end + 1);
}

function isDefined<T>(v: T | undefined): v is T {
  return v !== undefined;
}
