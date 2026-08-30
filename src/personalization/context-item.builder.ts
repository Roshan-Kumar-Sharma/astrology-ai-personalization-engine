import { Injectable } from '@nestjs/common';
import { DerivedFact } from '../astrology/types';
import { estimateTokens } from '../llm/tokenizer';
import { ContextBundle, SourceResult } from '../upstream/types';
import { ContextItem } from './types';

/**
 * Flattens everything we know into a flat list of atomic, individually
 * selectable context items.
 *
 * The flattening is the point. Upstream data arrives as four nested documents,
 * but selection has to happen at the granularity of *one fact* - the 10th house
 * is relevant to a career question while the 7th house in the same document is
 * not. Keeping the documents whole forces an all-or-nothing choice and is the
 * single biggest source of wasted tokens in a naive implementation.
 */
@Injectable()
export class ContextItemBuilder {
  build(bundle: ContextBundle, derived: DerivedFact[]): ContextItem[] {
    return [
      ...this.fromKundli(bundle),
      ...this.fromHoroscope(bundle),
      ...this.fromPanchang(bundle),
      ...this.fromDerived(derived),
    ];
  }

  private fromKundli(bundle: ContextBundle): ContextItem[] {
    const res = bundle.kundli;
    const k = res.data;
    if (!k) return [];
    const meta = sourceMeta(res);
    const items: ContextItem[] = [];

    if (k.lagna) {
      items.push(
        item({
          id: 'kundli.lagna',
          label: 'Ascendant (Lagna)',
          source: 'kundli',
          categories: ['self', 'general'],
          text: `Ascendant (lagna): ${k.lagna}.`,
          confidence: 'high',
          basis: ['kundli.lagna'],
          ...meta,
        }),
      );
    }

    if (k.moonSign) {
      items.push(
        item({
          id: 'kundli.moonSign',
          label: 'Moon Sign',
          source: 'kundli',
          categories: ['self', 'health', 'relationship', 'general'],
          text: `Moon sign (rashi): ${k.moonSign}.`,
          confidence: 'high',
          basis: ['kundli.moonSign'],
          ...meta,
        }),
      );
    }

    if (k.currentDasha?.mahadasha) {
      items.push(
        item({
          id: 'kundli.currentDasha',
          label: 'Current Dasha',
          source: 'kundli',
          categories: ['career', 'relationship', 'health', 'finance', 'self', 'timing', 'general'],
          text: `Current dasha: ${k.currentDasha.mahadasha} mahadasha, ${k.currentDasha.antardasha} antardasha.`,
          confidence: 'high',
          basis: ['kundli.currentDasha'],
          ...meta,
        }),
      );
    }

    for (const [houseNo, info] of Object.entries(k.houses ?? {})) {
      items.push(
        item({
          id: `kundli.house.${houseNo}`,
          label: `${ordinal(Number(houseNo))} House`,
          source: 'kundli',
          categories: ['general'],
          text: `House ${houseNo}: lord ${info.lord}, strength ${info.strength}.`,
          confidence: 'high',
          basis: [`kundli.houses.${houseNo}`],
          ...meta,
        }),
      );
    }

    return items;
  }

  private fromHoroscope(bundle: ContextBundle): ContextItem[] {
    const res = bundle.horoscope;
    const h = res.data;
    if (!h) return [];
    const meta = sourceMeta(res);

    const map: { key: keyof typeof h; label: string; category: ContextItem['categories'] }[] = [
      { key: 'career', label: 'Career Horoscope', category: ['career'] },
      { key: 'finance', label: 'Finance Horoscope', category: ['finance'] },
      { key: 'health', label: 'Health Horoscope', category: ['health'] },
      { key: 'relationship', label: 'Relationship Horoscope', category: ['relationship'] },
    ];

    return map
      .filter((m) => typeof h[m.key] === 'string' && h[m.key])
      .map((m) =>
        item({
          id: `horoscope.${String(m.key)}`,
          label: m.label,
          source: 'horoscope',
          categories: m.category,
          text: `${h[m.key]} (today's reading)`,
          confidence: 'high',
          basis: [`horoscope.${String(m.key)}`],
          ...meta,
        }),
      );
  }

  private fromPanchang(bundle: ContextBundle): ContextItem[] {
    const res = bundle.panchang;
    const p = res.data;
    if (!p) return [];
    const meta = sourceMeta(res);

    // A panchang from a previous day is worse than no panchang: it looks
    // authoritative and is silently wrong. Detect it and mark it low confidence
    // so the scorer down-ranks it and the confidence calculator notices.
    const today = new Date().toISOString().slice(0, 10);
    const isStaleDate = Boolean(p.date) && p.date !== today;
    const confidence: ContextItem['confidence'] = isStaleDate ? 'low' : 'high';
    const staleSuffix = isStaleDate ? ` (from ${p.date}, NOT today)` : '';

    const limbs: { key: 'tithi' | 'nakshatra' | 'yoga' | 'karana'; label: string }[] = [
      { key: 'tithi', label: "Today's Tithi" },
      { key: 'nakshatra', label: "Today's Nakshatra" },
      { key: 'yoga', label: "Today's Yoga" },
      { key: 'karana', label: "Today's Karana" },
    ];

    return limbs
      .filter((l) => p[l.key])
      .map((l) =>
        item({
          id: `panchang.${l.key}`,
          label: l.label,
          displayGroup: "Today's Panchang",
          source: 'panchang',
          categories: ['timing', 'general'],
          text: `${p[l.key]}${staleSuffix}`,
          confidence,
          basis: [`panchang.${l.key}`],
          ...meta,
        }),
      );
  }

  private fromDerived(derived: DerivedFact[]): ContextItem[] {
    return derived.map((f) =>
      item({
        id: f.id,
        label: f.label,
        source: 'derived',
        categories: f.categories,
        text: f.statement,
        confidence: f.confidence,
        basis: f.basis,
        // A derived statement strictly contains the raw field it was computed
        // from, so sending both is pure duplication. Superseding is the cheapest
        // real token saving in the pipeline.
        supersedes: supersededBy(f.id),
      }),
    );
  }
}

/**
 * Which raw item a derived item makes redundant.
 *
 * `derived.house.10` renders "House 10 (career...) falls in Cancer, ruled by
 * Moon, reported as strong" - which is everything `kundli.house.10` says plus
 * the sign and the signification. Keeping both would pay twice for one fact.
 */
function supersededBy(derivedId: string): string[] {
  const houseMatch = /^derived\.house\.(\d+)$/.exec(derivedId);
  if (houseMatch) return [`kundli.house.${houseMatch[1]}`];

  switch (derivedId) {
    case 'derived.dasha.position':
      return ['kundli.currentDasha'];
    case 'derived.moon.placement':
    case 'derived.moon.fallback':
      return ['kundli.moonSign'];
    case 'derived.panchang.resonance':
      return ['panchang.nakshatra'];
    default:
      return [];
  }
}

function item(partial: Omit<ContextItem, 'tokens'> & { tokens?: number }): ContextItem {
  return { ...partial, tokens: partial.tokens ?? estimateTokens(partial.text) };
}

function sourceMeta(res: SourceResult<unknown>): { ageMs?: number; stale?: boolean } {
  return { ageMs: res.ageMs, stale: res.outcome === 'stale' };
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}
