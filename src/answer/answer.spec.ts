import { ConfidenceService } from './confidence.service';
import { GroundednessService } from './groundedness.service';
import { ChartReliability } from '../astrology/types';
import { ContextBundle, Horoscope, Kundli, SourceResult } from '../upstream/types';
import { PersonalizationPlan, ScoredItem } from '../personalization/types';

function scored(id: string, label: string, text: string): ScoredItem {
  return {
    id,
    label,
    text,
    source: 'derived',
    categories: ['career'],
    tokens: 20,
    confidence: 'high',
    basis: [id],
    score: 100,
    tier: 'primary',
    reason: 'primary',
  };
}

const SELECTED: ScoredItem[] = [
  scored('derived.house.10', '10th House', 'House 10 falls in Cancer, ruled by Moon.'),
  scored('horoscope.career', 'Career Horoscope', 'Networking may bring new opportunities.'),
];

describe('GroundednessService', () => {
  const svc = new GroundednessService();

  describe('parsing', () => {
    it('reads the JSON contract', () => {
      const r = svc.parse('{"answer":"Hello","usedContextIds":["horoscope.career"]}');
      expect(r.answer).toBe('Hello');
      expect(r.citedIds).toEqual(['horoscope.career']);
      expect(r.usedFallbackParse).toBe(false);
    });

    it('tolerates markdown fences and surrounding prose', () => {
      const r = svc.parse('Sure!\n```json\n{"answer":"Hi","usedContextIds":[]}\n```');
      expect(r.answer).toBe('Hi');
      expect(r.usedFallbackParse).toBe(false);
    });

    /** A provider that ignores the contract must degrade, not fail. */
    it('falls back to raw text when the output is not JSON', () => {
      const r = svc.parse('Just a plain answer.');
      expect(r.answer).toBe('Just a plain answer.');
      expect(r.citedIds).toEqual([]);
      expect(r.usedFallbackParse).toBe(true);
    });
  });

  describe('verification', () => {
    it('accepts an answer that stays inside the supplied context', () => {
      const parsed = {
        answer: 'Your 10th house is ruled by Moon, and networking may help.',
        citedIds: ['derived.house.10', 'horoscope.career'],
        usedFallbackParse: false,
      };
      const r = svc.verify(parsed, SELECTED);
      expect(r.ungroundedEntities).toEqual([]);
      expect(r.fabricatedIds).toEqual([]);
      expect(r.verifiedIds).toHaveLength(2);
      expect(r.score).toBe(1);
    });

    /** The core anti-hallucination check. */
    it('catches a planet that was never in the context', () => {
      const parsed = {
        answer: 'Your strong Venus in the 10th house brings opportunity.',
        citedIds: ['derived.house.10'],
        usedFallbackParse: false,
      };
      const r = svc.verify(parsed, SELECTED);
      expect(r.ungroundedEntities).toContain('venus');
      expect(r.score).toBeLessThan(1);
    });

    it('catches a house that was never sent', () => {
      const parsed = {
        answer: 'Your 7th house suggests partnership changes.',
        citedIds: [],
        usedFallbackParse: false,
      };
      expect(svc.verify(parsed, SELECTED).ungroundedEntities).toContain('house 7');
    });

    it('reads ordinal words as well as digits', () => {
      const parsed = {
        answer: 'The seventh house is active.',
        citedIds: [],
        usedFallbackParse: false,
      };
      expect(svc.verify(parsed, SELECTED).ungroundedEntities).toContain('house 7');
    });

    /**
     * Many free-tier models are reasoning models that emit thinking as ordinary
     * content. Their thinking must never reach the user as the answer.
     */
    it('strips visible chain-of-thought before parsing', () => {
      const r = svc.parse(
        '<think>Let me work through the dasha…</think>{"answer":"Hi","usedContextIds":[]}',
      );
      expect(r.answer).toBe('Hi');
      expect(r.usedFallbackParse).toBe(false);
    });

    it('records when the model ignored the output contract', () => {
      const parsed = svc.parse('Just prose, no JSON at all.');
      const r = svc.verify(parsed, SELECTED);
      expect(r.contractIgnored).toBe(true);
      // Without a citation list we cannot verify anything, so the score must fall.
      expect(r.score).toBeLessThan(1);
    });

    it('catches a citation for context we never sent', () => {
      const parsed = {
        answer: 'All good.',
        citedIds: ['kundli.house.7'],
        usedFallbackParse: false,
      };
      const r = svc.verify(parsed, SELECTED);
      expect(r.fabricatedIds).toEqual(['kundli.house.7']);
      expect(r.verifiedIds).toEqual([]);
    });
  });

  describe('sourcesUsed', () => {
    it('reports what the model verifiably cited', () => {
      const report = {
        verifiedIds: ['horoscope.career'],
        fabricatedIds: [],
        ungroundedEntities: [],
        contractIgnored: false,
        score: 1,
      };
      expect(svc.sourcesUsed(report, SELECTED)).toEqual(['Career Horoscope']);
    });

    it('falls back to the highest-ranked context when nothing was cited', () => {
      const report = {
        verifiedIds: [],
        fabricatedIds: [],
        ungroundedEntities: [],
        contractIgnored: false,
        score: 1,
      };
      expect(svc.sourcesUsed(report, SELECTED).length).toBeGreaterThan(0);
    });

    it('collapses panchang limbs into one reader-facing source', () => {
      const limbs: ScoredItem[] = ['tithi', 'nakshatra'].map((k) => ({
        ...scored(`panchang.${k}`, k, `${k} value`),
        displayGroup: "Today's Panchang",
      }));
      const report = {
        verifiedIds: ['panchang.tithi', 'panchang.nakshatra'],
        fabricatedIds: [],
        ungroundedEntities: [],
        contractIgnored: false,
        score: 1,
      };
      expect(svc.sourcesUsed(report, limbs)).toEqual(["Today's Panchang"]);
    });
  });
});

describe('ConfidenceService', () => {
  const svc = new ConfidenceService();

  const ok = <T>(source: SourceResult<T>['source'], data: T): SourceResult<T> => ({
    source,
    outcome: 'ok',
    data,
    latencyMs: 10,
    attempts: 1,
  });
  const failed = <T>(source: SourceResult<T>['source']): SourceResult<T> => ({
    source,
    outcome: 'failed',
    error: 'boom',
    latencyMs: 10,
    attempts: 2,
  });

  const healthyBundle = (): ContextBundle => ({
    user: ok('user', {} as any),
    kundli: ok('kundli', {} as any),
    horoscope: ok('horoscope', {} as any),
    panchang: ok('panchang', {} as any),
    transit: ok('transit', {} as any),
  });

  const plan = (overrides: Partial<PersonalizationPlan> = {}): PersonalizationPlan => ({
    intent: 'career',
    intentConfidence: 0.98,
    intentMethod: 'lexicon',
    secondaryIntents: [],
    horizon: 'quarter',
    focus: [],
    style: {
      languageCode: 'en',
      tier: 'premium',
      language: 'English',
      tone: 'motivational',
      maxWords: 250,
      jargonLevel: 'balanced',
    },
    selected: SELECTED,
    excluded: [],
    tokenBudget: 900,
    tokensUsed: 40,
    tokensAvailable: 200,
    naiveBaselineTokens: 230,
    reliability: {
      birthTime: 'exact',
      housesUsable: true,
      inconsistencies: [],
      notes: [],
    } as ChartReliability,
    constraints: [],
    notes: [],
    ...overrides,
  });

  it('reports HIGH when everything is healthy', () => {
    const r = svc.compute({ bundle: healthyBundle(), plan: plan() });
    expect(r.label).toBe('HIGH');
    expect(r.caps).toEqual([]);
  });

  /** Losing house analysis is categorical, not a gradual penalty. */
  it('caps at MEDIUM when the birth time cannot support houses', () => {
    const r = svc.compute({
      bundle: healthyBundle(),
      plan: plan({
        reliability: { birthTime: 'unknown', housesUsable: false, inconsistencies: [], notes: [] },
      }),
    });
    expect(r.label).toBe('MEDIUM');
    expect(r.caps.join(' ')).toContain('house division');
  });

  it('caps when the kundli could not be fetched', () => {
    const bundle = { ...healthyBundle(), kundli: failed<Kundli>('kundli') };
    const r = svc.compute({ bundle, plan: plan() });
    expect(r.label).not.toBe('HIGH');
    expect(r.caps.join(' ')).toContain('Kundli unavailable');
  });

  it('drops to LOW when both the kundli and horoscope are gone', () => {
    const bundle = {
      ...healthyBundle(),
      kundli: failed<Kundli>('kundli'),
      horoscope: failed<Horoscope>('horoscope'),
    };
    expect(svc.compute({ bundle, plan: plan() }).label).toBe('LOW');
  });

  it('caps when the chart failed consistency validation', () => {
    const r = svc.compute({
      bundle: healthyBundle(),
      plan: plan({
        reliability: {
          birthTime: 'exact',
          housesUsable: false,
          inconsistencies: ['House 10 lord wrong'],
          notes: [],
        },
      }),
    });
    expect(r.caps.join(' ')).toContain('consistency validation');
  });

  it('lowers confidence when the answer left the supplied context', () => {
    const clean = svc.compute({ bundle: healthyBundle(), plan: plan() });
    const dirty = svc.compute({
      bundle: healthyBundle(),
      plan: plan(),
      groundedness: {
        verifiedIds: [],
        fabricatedIds: [],
        ungroundedEntities: ['venus', 'house 7'],
        contractIgnored: false,
        score: 0.4,
      },
    });
    expect(dirty.score).toBeLessThan(clean.score);
  });

  it('lowers confidence when a low-certainty intent was guessed', () => {
    const sure = svc.compute({ bundle: healthyBundle(), plan: plan() });
    const unsure = svc.compute({
      bundle: healthyBundle(),
      plan: plan({ intentConfidence: 0.3, intentMethod: 'default', intent: 'general' }),
    });
    expect(unsure.score).toBeLessThan(sure.score);
  });

  it('explains every factor it used', () => {
    const r = svc.compute({ bundle: healthyBundle(), plan: plan() });
    expect(r.factors.map((f) => f.name).sort()).toEqual([
      'birthTimeReliability',
      'contextCoverage',
      'dataCompleteness',
      'groundedness',
      'intentCertainty',
    ]);
    for (const f of r.factors) expect(f.note).toBeTruthy();
  });
});
