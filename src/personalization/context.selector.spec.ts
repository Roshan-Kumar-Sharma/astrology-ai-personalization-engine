import { ChartReliability } from '../astrology/types';
import { ContextSelector } from './context.selector';
import { ContextItem, Horizon, Intent } from './types';

const reliable: ChartReliability = {
  birthTime: 'exact',
  housesUsable: true,
  inconsistencies: [],
  notes: [],
};

function item(id: string, overrides: Partial<ContextItem> = {}): ContextItem {
  return {
    id,
    label: id,
    source: id.startsWith('derived') ? 'derived' : (id.split('.')[0] as ContextItem['source']),
    categories: ['general'],
    text: `text for ${id}`,
    tokens: 10,
    confidence: 'high',
    basis: [id],
    ...overrides,
  };
}

const CANDIDATES = [
  item('kundli.house.10'),
  item('kundli.house.7'),
  item('kundli.house.6'),
  item('kundli.lagna'),
  item('horoscope.career'),
  item('horoscope.relationship'),
  item('horoscope.health'),
  item('panchang.tithi'),
  item('panchang.nakshatra'),
  item('derived.dasha.position'),
  item('derived.dasha.themes'),
];

function select(
  intent: Intent,
  horizon: Horizon,
  items = CANDIDATES,
  tokenBudget = 1000,
  reliability = reliable,
) {
  return new ContextSelector().select({
    items,
    intent,
    secondaryIntents: [],
    horizon,
    tokenBudget,
    reliability,
  });
}

const ids = (r: ReturnType<ContextSelector['select']>) => r.selected.map((i) => i.id);
const excludedFor = (r: ReturnType<ContextSelector['select']>, id: string) =>
  r.excluded.find((e) => e.id === id);

describe('ContextSelector', () => {
  it('sends the primary sources for the intent and drops the excluded ones', () => {
    const r = select('career', 'unspecified');
    expect(ids(r)).toContain('kundli.house.10');
    expect(ids(r)).toContain('horoscope.career');
    expect(ids(r)).toContain('derived.dasha.position');

    expect(ids(r)).not.toContain('horoscope.relationship');
    expect(excludedFor(r, 'horoscope.relationship')?.reason).toBe('rule:excluded');
    expect(excludedFor(r, 'kundli.house.7')?.reason).toBe('rule:excluded');
  });

  it('ranks primary above secondary', () => {
    const r = select('career', 'unspecified');
    const primary = r.selected.find((i) => i.id === 'horoscope.career')!;
    const secondary = r.selected.find((i) => i.id === 'kundli.house.6')!;
    expect(primary.score).toBeGreaterThan(secondary.score);
    expect(primary.tier).toBe('primary');
    expect(secondary.tier).toBe('secondary');
  });

  /**
   * The horizon axis: identical question, different time frame, different
   * context. The panchang describes one day and must not survive a
   * multi-month horizon.
   */
  describe('time horizon', () => {
    it('promotes the panchang for a same-day question', () => {
      const r = select('career', 'today');
      expect(ids(r)).toContain('panchang.tithi');
      const panchang = r.selected.find((i) => i.id === 'panchang.tithi')!;
      expect(panchang.reason).toContain('promoted');
    });

    it('drops the panchang entirely over a multi-month horizon', () => {
      const r = select('career', 'quarter');
      expect(ids(r)).not.toContain('panchang.tithi');
      expect(ids(r)).not.toContain('panchang.nakshatra');
      expect(excludedFor(r, 'panchang.tithi')?.reason).toBe('rule:horizon-drop');
    });

    it('demotes but keeps the daily horoscope over a year', () => {
      const r = select('career', 'year');
      const horoscope = r.selected.find((i) => i.id === 'horoscope.career');
      expect(horoscope).toBeDefined();
      expect(horoscope!.reason).toContain('demoted');
      // Demoted below an undemoted primary.
      const house = r.selected.find((i) => i.id === 'kundli.house.10')!;
      expect(house.score).toBeGreaterThan(horoscope!.score);
    });

    it('also drops derived panchang facts, not just raw ones', () => {
      const withDerived = [...CANDIDATES, item('derived.panchang.lord')];
      const r = select('career', 'quarter', withDerived);
      expect(ids(r)).not.toContain('derived.panchang.lord');
    });
  });

  describe('redundancy', () => {
    it('drops a raw field superseded by the derived fact that restates it', () => {
      const items = [
        item('kundli.house.10'),
        item('derived.house.10', { supersedes: ['kundli.house.10'] }),
        item('horoscope.career'),
      ];
      const r = select('career', 'unspecified', items);
      expect(ids(r)).toContain('derived.house.10');
      expect(ids(r)).not.toContain('kundli.house.10');
      expect(excludedFor(r, 'kundli.house.10')?.detail).toContain('Superseded');
    });

    it('keeps the raw field when nothing supersedes it', () => {
      const r = select('career', 'unspecified');
      expect(ids(r)).toContain('kundli.house.10');
    });
  });

  describe('reliability gate', () => {
    it('removes every house-based item when the birth time is unusable', () => {
      const r = select('career', 'unspecified', CANDIDATES, 1000, {
        birthTime: 'unknown',
        housesUsable: false,
        inconsistencies: [],
        notes: [],
      });
      expect(ids(r).some((id) => /\.house\.\d+$/.test(id))).toBe(false);
      expect(ids(r)).not.toContain('kundli.lagna');
      expect(excludedFor(r, 'kundli.house.10')?.reason).toBe('reliability');
      // Non-house context still flows.
      expect(ids(r)).toContain('horoscope.career');
      expect(ids(r)).toContain('derived.dasha.position');
    });

    /** A budget surplus must never let an unsound item back in. */
    it('keeps house items out even with unlimited budget', () => {
      const r = select('career', 'unspecified', CANDIDATES, 100_000, {
        birthTime: 'unknown',
        housesUsable: false,
        inconsistencies: [],
        notes: [],
      });
      expect(ids(r).some((id) => id.includes('.house.'))).toBe(false);
    });
  });

  describe('budget', () => {
    it('packs by priority and reports what did not fit', () => {
      const r = select('career', 'unspecified', CANDIDATES, 25);
      expect(r.tokensUsed).toBeLessThanOrEqual(25);
      expect(r.excluded.some((e) => e.reason === 'budget')).toBe(true);
      // The highest-priority item still made it.
      expect(r.selected[0].tier).toBe('primary');
    });

    it('continues past an item that does not fit rather than stopping', () => {
      const items = [
        item('horoscope.career', { tokens: 500 }),
        item('kundli.house.10', { tokens: 5 }),
        item('derived.dasha.position', { tokens: 5 }),
      ];
      const r = select('career', 'unspecified', items, 20);
      expect(ids(r)).toContain('kundli.house.10');
      expect(ids(r)).toContain('derived.dasha.position');
      expect(excludedFor(r, 'horoscope.career')?.reason).toBe('budget');
    });

    it('forces one item through rather than sending an empty context', () => {
      const r = select('career', 'unspecified', CANDIDATES, 1);
      expect(r.selected).toHaveLength(1);
      expect(r.notes.join(' ')).toContain('forced');
    });

    /** Budget decides how much of the relevant set fits, never what is relevant. */
    it('excludes background items on relevance even when budget remains', () => {
      const r = select('career', 'unspecified', CANDIDATES, 100_000);
      expect(r.tokensUsed).toBeLessThan(r.tokensAvailable);
      expect(r.excluded.some((e) => e.reason === 'rule:below-threshold')).toBe(true);
    });
  });

  it('lifts items belonging to a detected secondary intent', () => {
    const base = new ContextSelector().select({
      items: CANDIDATES,
      intent: 'career',
      secondaryIntents: [],
      horizon: 'unspecified',
      tokenBudget: 1000,
      reliability: reliable,
    });
    const withSecondary = new ContextSelector().select({
      items: CANDIDATES,
      intent: 'career',
      secondaryIntents: ['health'],
      horizon: 'unspecified',
      tokenBudget: 1000,
      reliability: reliable,
    });
    expect(base.selected.map((i) => i.id)).not.toContain('horoscope.health');
    // `horoscope.health` is excluded by the career rule, so a secondary intent
    // cannot resurrect it - exclusions are absolute. The 6th house, which is
    // merely secondary for career, is what gets lifted.
    expect(withSecondary.selected.map((i) => i.id)).toContain('kundli.house.6');
  });

  it('penalises stale and low-confidence data', () => {
    const items = [
      item('horoscope.career'),
      item('horoscope.finance', { stale: true }),
      item('kundli.house.10', { confidence: 'low' }),
    ];
    const r = select('career', 'unspecified', items);
    const fresh = r.selected.find((i) => i.id === 'horoscope.career')!;
    const stale = r.selected.find((i) => i.id === 'horoscope.finance');
    expect(stale?.reason).toContain('stale');
    expect(fresh.score).toBeGreaterThan(stale?.score ?? 0);
  });
});
