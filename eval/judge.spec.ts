import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIMENSIONS,
  JudgeCase,
  MUTATIONS,
  Probe,
  ProbeResult,
  Verdict,
  buildProbes,
  deterministicChecks,
  devanagariRatio,
  mutate,
  parseVerdict,
  scoreCalibration,
  scoredOn,
  scriptCheck,
} from './judge';
import { planFor } from './harness';

const CASES: JudgeCase[] = readFileSync(join(__dirname, 'dataset', 'judge.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as JudgeCase);

const byId = new Map(CASES.map((c) => [c.id, c]));

const allPass = (): Verdict =>
  Object.fromEntries(DIMENSIONS.map((d) => [d, { pass: true, reason: '' }])) as Verdict;

describe('parseVerdict', () => {
  const good = JSON.stringify(allPass());

  it('parses a clean verdict', () => {
    const v = parseVerdict(good)!;
    expect(v.grounded.pass).toBe(true);
    expect(DIMENSIONS.every((d) => d in v)).toBe(true);
  });

  it('tolerates fences and visible reasoning', () => {
    expect(parseVerdict('```json\n' + good + '\n```')).toBeDefined();
    expect(parseVerdict('<think>let me look</think>' + good)).toBeDefined();
    expect(parseVerdict('Here is my grading:\n' + good)).toBeDefined();
  });

  it('refuses a partial verdict rather than guessing', () => {
    const partial = allPass() as Partial<Verdict>;
    delete partial.language;
    expect(parseVerdict(JSON.stringify(partial))).toBeUndefined();
  });

  it('refuses a non-boolean pass', () => {
    const v = allPass() as Record<string, unknown>;
    v.hedged = { pass: 'yes', reason: '' };
    expect(parseVerdict(JSON.stringify(v))).toBeUndefined();
  });

  it('refuses prose and truncation', () => {
    expect(parseVerdict('The answer looks fine to me.')).toBeUndefined();
    expect(parseVerdict(good.slice(0, 40))).toBeUndefined();
  });
});

/**
 * The calibration set is only a measurement if its clean answers really are
 * clean. Each of these pins one property a hand-written answer could quietly
 * lose when the rules change what the engine selects.
 */
describe('calibration dataset integrity', () => {
  it.each(CASES.map((c) => [c.id, c] as const))(
    '%s: the clean answer names nothing the context does not contain',
    (_, kase) => {
      const [probe] = buildProbes([kase], { only: 'clean' });
      const checks = deterministicChecks(probe);
      expect(checks.grounded).toBe(true);
      expect(checks.hedged).toBe(true);
    },
  );

  it.each(CASES.map((c) => [c.id, c] as const))('%s: fits the word cap', (_, kase) => {
    const [probe] = buildProbes([kase], { only: 'clean' });
    const checks = deterministicChecks(probe);
    expect(checks.words).toBeLessThanOrEqual(probe.plan.style.maxWords);
  });

  it.each(CASES.map((c) => [c.id, c] as const))('%s: is in the right script', (_, kase) => {
    const plan = planFor(kase.question, kase.userId);
    const lang = plan.style.languageCode;
    if (lang === 'hi') expect(devanagariRatio(kase.answer)).toBeGreaterThanOrEqual(0.5);
    else expect(devanagariRatio(kase.answer)).toBe(0);
    // answer_en exists exactly when the clean answer is not English.
    expect(kase.answer_en !== undefined).toBe(lang !== 'en');
    if (kase.answer_en) expect(devanagariRatio(kase.answer_en)).toBe(0);
  });

  it('every swap partner exists and shares the language', () => {
    for (const c of CASES.filter((c) => c.swapWith)) {
      const other = byId.get(c.swapWith!);
      expect(other).toBeDefined();
      expect(planFor(other!.question, other!.userId).style.languageCode).toBe(
        planFor(c.question, c.userId).style.languageCode,
      );
    }
  });
});

describe('mutations', () => {
  const probesFor = (m: (typeof MUTATIONS)[number]) => buildProbes(CASES, { only: m });

  it('invent_planet applies everywhere and the regex verifier catches it - except in Hindi', () => {
    const probes = probesFor('invent_planet');
    expect(probes).toHaveLength(CASES.length);
    for (const p of probes) {
      const lang = p.plan.style.languageCode;
      // The deterministic verifier looks for English planet names. A planet
      // written as शुक्र walks straight past it, which is one of the gaps the
      // judge exists to cover - so the test pins the gap, not the fix.
      expect(deterministicChecks(p).grounded).toBe(lang === 'hi');
    }
  });

  it('invent_planet names a house where houses were withheld', () => {
    const p = probesFor('invent_planet').find((p) => !p.plan.reliability.housesUsable)!;
    expect(p.answer).toMatch(/10th house|दसवें भाव/);
  });

  it('assert_certainty slips past every output regex, on purpose', () => {
    const probes = probesFor('assert_certainty');
    expect(probes).toHaveLength(CASES.length);
    for (const p of probes) expect(deterministicChecks(p).hedged).toBe(true);
  });

  it('swap_answer applies only where a partner is named, and changes the text', () => {
    const probes = probesFor('swap_answer');
    expect(probes.map((p) => p.caseId).sort()).toEqual(
      CASES.filter((c) => c.swapWith)
        .map((c) => c.id)
        .sort(),
    );
    for (const p of probes) expect(p.answer).not.toBe(byId.get(p.caseId)!.answer);
  });

  it('wrong_language applies only to non-English users; the script check sees Hindi, not Hinglish', () => {
    const probes = probesFor('wrong_language');
    for (const p of probes) {
      const lang = p.plan.style.languageCode;
      expect(lang).not.toBe('en');
      const check = deterministicChecks(p).language;
      if (lang === 'hi') expect(check).toBe(false);
      else expect(check).toBeUndefined();
    }
  });

  it('break_constraint applies only where a constrain policy fired, and no regex catches it', () => {
    const probes = probesFor('break_constraint');
    expect(probes.map((p) => p.caseId).sort()).toEqual(['jq-05', 'jq-06', 'jq-07']);
    for (const p of probes) expect(deterministicChecks(p).hedged).toBe(true);
  });

  it('a mutation that does not apply returns undefined rather than a clean copy', () => {
    const en = CASES.find((c) => c.userId === 'user_101')!;
    expect(mutate(en, 'wrong_language', planFor(en.question, en.userId), byId)).toBeUndefined();
    const unconstrained = byId.get('jq-01')!;
    expect(
      mutate(unconstrained, 'break_constraint', planFor(unconstrained.question, 'user_101'), byId),
    ).toBeUndefined();
  });

  it('the full calibration run is 35 probes', () => {
    const probes = buildProbes(CASES);
    const kinds = probes.reduce<Record<string, number>>((acc, p) => {
      acc[p.kind] = (acc[p.kind] ?? 0) + 1;
      return acc;
    }, {});
    expect(kinds).toEqual({
      clean: 8,
      invent_planet: 8,
      assert_certainty: 8,
      swap_answer: 4,
      wrong_language: 4,
      break_constraint: 3,
    });
    expect(probes).toHaveLength(35);
  });
});

describe('scriptCheck', () => {
  it('reads Devanagari for Hindi and its absence for English', () => {
    expect(scriptCheck('hi', 'यह हिंदी है')).toBe(true);
    expect(scriptCheck('hi', 'this is English')).toBe(false);
    expect(scriptCheck('en', 'this is English')).toBe(true);
    expect(scriptCheck('en', 'यह हिंदी है')).toBe(false);
  });

  it('cannot tell Hinglish from English, and says so', () => {
    expect(scriptCheck('hinglish', 'aaj ka din steady kaam ke liye hai')).toBeUndefined();
    expect(scriptCheck('hinglish', 'today is for steady work')).toBeUndefined();
    expect(scriptCheck('hinglish', 'आज का दिन')).toBe(false);
  });
});

describe('scoreCalibration', () => {
  const probe = (kind: Probe['kind'], target?: Probe['target'], policyConstrained = true) =>
    ({ caseId: 'x', kind, target, policyConstrained }) as ProbeResult['probe'];
  const checks = { grounded: true, hedged: true, withinLength: true, words: 0 };
  const verdict = (fails: Partial<Record<(typeof DIMENSIONS)[number], true>> = {}): Verdict =>
    Object.fromEntries(DIMENSIONS.map((d) => [d, { pass: !fails[d], reason: '' }])) as Verdict;

  it('separates recall, false positives, collateral and failed calls', () => {
    const results: ProbeResult[] = [
      { probe: probe('clean'), verdict: verdict(), checks },
      { probe: probe('clean'), verdict: verdict({ hedged: true }), checks },
      { probe: probe('invent_planet', 'grounded'), verdict: verdict({ grounded: true }), checks },
      { probe: probe('invent_planet', 'grounded'), verdict: verdict(), checks },
      {
        probe: probe('break_constraint', 'constrained'),
        verdict: verdict({ constrained: true, hedged: true }),
        checks,
      },
      { probe: probe('assert_certainty', 'hedged'), verdict: undefined, checks },
    ];
    const r = scoreCalibration(results);

    expect(r.probes).toBe(6);
    expect(r.failed).toBe(1);
    const by = Object.fromEntries(r.perDimension.map((d) => [d.dimension, d]));
    expect(by.grounded).toMatchObject({ caught: 1, mutated: 2, falsePositives: 0, clean: 2 });
    expect(by.hedged).toMatchObject({ caught: 0, mutated: 0, falsePositives: 1, clean: 2 });
    expect(by.constrained).toMatchObject({ caught: 1, mutated: 1 });
    expect(r.collateral).toEqual({ break_constraint: { hedged: 1 } });
    expect(r.collateralConfirmed).toEqual({});
    expect(r.misses).toHaveLength(1);
    expect(r.falsePositives).toHaveLength(1);
  });

  it('counts collateral as confirmed when a deterministic check fails on the same probe', () => {
    const results: ProbeResult[] = [
      {
        probe: probe('swap_answer', 'in_scope'),
        verdict: verdict({ in_scope: true, grounded: true }),
        checks: { ...checks, grounded: false },
      },
    ];
    const r = scoreCalibration(results);
    expect(r.collateral).toEqual({ swap_answer: { grounded: 1 } });
    expect(r.collateralConfirmed).toEqual({ swap_answer: { grounded: 1 } });
  });

  it('scores constrained only where a policy added constraints', () => {
    // On an unconstrained question the block is the four universal lines,
    // which restate grounded and hedged - a flag there is an echo, not a finding.
    const results: ProbeResult[] = [
      { probe: probe('clean', undefined, false), verdict: verdict({ constrained: true }), checks },
      { probe: probe('clean', undefined, true), verdict: verdict({ constrained: true }), checks },
      {
        probe: probe('assert_certainty', 'hedged', false),
        verdict: verdict({ hedged: true, constrained: true }),
        checks,
      },
      {
        probe: probe('assert_certainty', 'hedged', true),
        verdict: verdict({ hedged: true, constrained: true }),
        checks,
      },
    ];
    const r = scoreCalibration(results);
    const c = r.perDimension.find((d) => d.dimension === 'constrained')!;
    expect(c).toMatchObject({ scoredOn: 2, falsePositives: 1, clean: 1 });
    expect(r.collateral).toEqual({ assert_certainty: { constrained: 1 } });
    expect(r.falsePositives).toHaveLength(1);
    expect(scoredOn({ policyConstrained: false }, 'constrained')).toBe(false);
    expect(scoredOn({ policyConstrained: false }, 'grounded')).toBe(true);
  });

  it('counts probes that needed the retry', () => {
    const results: ProbeResult[] = [
      { probe: probe('clean'), verdict: verdict(), checks, attempts: 1 },
      { probe: probe('clean'), verdict: verdict(), checks, attempts: 2 },
      { probe: probe('clean'), verdict: undefined, checks, attempts: 2 },
    ];
    expect(scoreCalibration(results)).toMatchObject({ retried: 2, failed: 1 });
  });

  it('reports the deterministic check on the same probes where one exists', () => {
    const results: ProbeResult[] = [
      {
        probe: probe('invent_planet', 'grounded'),
        verdict: verdict({ grounded: true }),
        checks: { ...checks, grounded: false },
      },
      {
        probe: probe('invent_planet', 'grounded'),
        verdict: verdict({ grounded: true }),
        checks: { ...checks, grounded: true },
      },
    ];
    const g = scoreCalibration(results).perDimension.find((d) => d.dimension === 'grounded')!;
    expect(g).toMatchObject({ caught: 2, deterministicCaught: 1, deterministicApplicable: 2 });
  });
});
