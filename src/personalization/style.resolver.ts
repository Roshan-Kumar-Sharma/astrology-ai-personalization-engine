import { Injectable } from '@nestjs/common';
import { UserProfile } from '../upstream/types';
import {
  DEFAULT_LANGUAGE,
  DEFAULT_TIER,
  HORIZON_LENGTH_FACTOR,
  INTENT_LENGTH_FACTOR,
  LANGUAGE_NAMES,
  MAX_WORDS,
  MIN_WORDS,
  TIER_BASE_WORDS,
  TIER_JARGON,
  TONE_ALIASES,
} from './config/style.config';
import { Horizon, Intent, ResponseStyle, Tone } from './types';

/**
 * Resolves how the answer should sound.
 *
 * Every field degrades independently to a safe default. If the User service is
 * down we still answer - in English, neutrally, at free-tier length - rather
 * than failing. Losing personalization is a much smaller failure than losing
 * the answer, and the confidence score records that it happened.
 */
@Injectable()
export class StyleResolver {
  resolve(user: UserProfile | undefined, intent: Intent, horizon: Horizon): ResponseStyle {
    const languageCode = this.resolveLanguage(user?.language);
    const tier = this.resolveTier(user?.subscription);

    return {
      languageCode,
      tier,
      language: LANGUAGE_NAMES[languageCode] ?? 'English',
      tone: this.resolveTone(user?.tonePreference),
      maxWords: this.resolveMaxWords(tier, intent, horizon),
      jargonLevel: TIER_JARGON[tier] ?? 'plain',
    };
  }

  private resolveLanguage(raw: string | undefined): string {
    if (!raw) return DEFAULT_LANGUAGE;
    const key = raw.trim().toLowerCase();
    if (LANGUAGE_NAMES[key]) return key;
    // Accept locale forms such as "hi-IN" or "en_US".
    const base = key.split(/[-_]/)[0];
    return LANGUAGE_NAMES[base] ? base : DEFAULT_LANGUAGE;
  }

  private resolveTone(raw: string | undefined): Tone {
    if (!raw) return 'neutral';
    return TONE_ALIASES[raw.trim().toLowerCase()] ?? 'neutral';
  }

  private resolveTier(raw: string | undefined): string {
    const key = (raw ?? DEFAULT_TIER).trim().toLowerCase();
    return TIER_BASE_WORDS[key] !== undefined ? key : DEFAULT_TIER;
  }

  private resolveMaxWords(tier: string, intent: Intent, horizon: Horizon): number {
    const base = TIER_BASE_WORDS[tier] ?? TIER_BASE_WORDS[DEFAULT_TIER];
    const scaled = base * HORIZON_LENGTH_FACTOR[horizon] * (INTENT_LENGTH_FACTOR[intent] ?? 1);
    return clamp(Math.round(scaled / 10) * 10, MIN_WORDS, MAX_WORDS);
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
