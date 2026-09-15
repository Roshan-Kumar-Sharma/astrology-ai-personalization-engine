import { runAll } from './score';

/**
 * The golden eval as a regression gate.
 *
 * BASELINE is what the engine measured on 2026-09-15, not what it should score.
 * Several numbers here are poor; they are pinned anyway, because the point of a
 * baseline is to make the next change's effect visible, not to look good. The
 * assertions are one-sided - improvements pass, regressions fail - so raising a
 * number is a deliberate edit to this file with the new figure in the diff.
 *
 * Runs in CI: no LLM, no network, ~200 cases in well under a second.
 */
const BASELINE = {
  intentAccuracy: 0.7333,
  horizonAccuracy: 0.875,
  secondaryRecall: 0.0769,
  blockRecall: 0.5455,
  falsePositiveRate: 0.0278,
  policyAccuracy: 1.0,
  constraintRecall: 0.6364,
  selectionPassRate: 0.8846,
  includeRecall: 0.9556,
  excludeAccuracy: 0.9565,
  reasonAccuracy: 0.9,
};

/** Floating-point slack, so a rounding wobble is not a build failure. */
const EPS = 0.0001;

describe('golden eval', () => {
  const r = runAll();

  const atLeast = (actual: number, floor: number) =>
    expect(actual).toBeGreaterThanOrEqual(floor - EPS);
  const atMost = (actual: number, ceiling: number) =>
    expect(actual).toBeLessThanOrEqual(ceiling + EPS);

  it('has the expected dataset size', () => {
    expect(r.intent.total).toBe(120);
    expect(r.safety.total).toBe(69);
    expect(r.selection.total).toBe(26);
  });

  it('does not regress on intent classification', () => {
    atLeast(r.intent.accuracy, BASELINE.intentAccuracy);
  });

  it('does not regress on horizon extraction', () => {
    atLeast(r.horizon.accuracy, BASELINE.horizonAccuracy);
  });

  it('does not regress on secondary intent detection', () => {
    atLeast(r.secondaryRecall.rate, BASELINE.secondaryRecall);
  });

  it('does not regress on refusing what must be refused', () => {
    atLeast(r.safety.blockRecall, BASELINE.blockRecall);
  });

  it('does not start refusing questions it should answer', () => {
    atMost(r.safety.falsePositiveRate, BASELINE.falsePositiveRate);
  });

  it('always cites the policy it actually blocked on', () => {
    atLeast(r.safety.policyAccuracy, BASELINE.policyAccuracy);
  });

  it('does not regress on attaching constrain-action policies', () => {
    atLeast(r.safety.constraintRecall, BASELINE.constraintRecall);
  });

  it('does not regress on context selection', () => {
    atLeast(r.selection.passRate, BASELINE.selectionPassRate);
    atLeast(r.selection.includeRecall, BASELINE.includeRecall);
    atLeast(r.selection.excludeAccuracy, BASELINE.excludeAccuracy);
  });

  /**
   * Decision 1 in the README: the panchang is *dropped* at long horizons and the
   * horoscope is only *demoted*. That distinction only holds if the exclusion
   * carries the right reason - a budget eviction that happens to remove the
   * panchang would score identically on the item list while meaning something
   * completely different.
   */
  it('excludes items for the documented reason, not an equivalent-looking one', () => {
    atLeast(r.selection.reasonAccuracy, BASELINE.reasonAccuracy);
  });
});
