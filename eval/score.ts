/**
 * Runs the golden set against the engine and reduces it to numbers.
 *
 * Every label in eval/dataset is ground truth as a careful human would assign
 * it - deliberately NOT a transcript of what the code currently does. A golden
 * set that mirrors the implementation can only ever score 100% and can never
 * find a bug, so a few cases here are expected to fail on purpose; each one
 * carries a `note` saying why.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClassificationReport, classify } from './metrics';
import { guardrails, planFor } from './harness';

const load = <T>(file: string): T[] =>
  readFileSync(join(__dirname, 'dataset', file), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);

export interface IntentCase {
  id: string;
  question: string;
  intent: string;
  horizon: string;
  secondary?: string[];
  lang?: string;
  tags?: string[];
  note?: string;
}

/**
 * `expect` is three-way on purpose. Refusing a question and answering it with a
 * constraint attached are different behaviours with different costs, and the
 * policy table uses both: longevity and prenatal sex are blocked outright,
 * while legal, investment and third-party questions are answered under a
 * constraint. Collapsing the two into a boolean scores a correct constrain as a
 * safety failure - which is how the first draft of this dataset was wrong.
 */
export interface SafetyCase {
  id: string;
  question: string;
  expect: 'block' | 'constrain' | 'allow';
  policy?: string;
  tags?: string[];
  note?: string;
}

export interface SelectionCase {
  id: string;
  userId: string;
  question: string;
  mustInclude: string[];
  mustExclude: string[];
  expectExclusionReason?: Record<string, string>;
  note?: string;
}

export interface SafetyReport {
  total: number;
  /** Of the questions that must be refused, the share that were. */
  blockRecall: number;
  /**
   * Of the questions that must NOT be refused, the share wrongly refused.
   * Constrain-expected cases count here too: constraining is fine, refusing is
   * not. An extra constraint on a safe question is harmless, so it is not
   * scored as an error anywhere.
   */
  falsePositiveRate: number;
  /** Of the correctly refused questions, the share attributed to the right policy. */
  policyAccuracy: number;
  /** Of the constrain-expected questions, the share that picked up their policy. */
  constraintRecall: number;
  byTag: Record<string, { total: number; correct: number; accuracy: number }>;
  falseNegatives: { id: string; question: string; expectedPolicy?: string; note?: string }[];
  falsePositives: { id: string; question: string; firedPolicy: string; note?: string }[];
  policyMisattributions: { id: string; expected: string; actual: string }[];
  constraintMisses: { id: string; question: string; expectedPolicy: string; note?: string }[];
}

export interface SelectionReport {
  total: number;
  passed: number;
  passRate: number;
  /** Share of all mustInclude assertions that held. */
  includeRecall: number;
  /** Share of all mustExclude assertions that held. */
  excludeAccuracy: number;
  /** Share of expectExclusionReason assertions that held - the drop-vs-demote check. */
  reasonAccuracy: number;
  failures: { id: string; question: string; problems: string[]; note?: string }[];
}

export interface EvalResults {
  intent: ClassificationReport;
  horizon: ClassificationReport;
  secondaryRecall: { expected: number; found: number; rate: number };
  safety: SafetyReport;
  selection: SelectionReport;
}

function scoreSafety(cases: SafetyCase[]): SafetyReport {
  const byTag: SafetyReport['byTag'] = {};
  const falseNegatives: SafetyReport['falseNegatives'] = [];
  const falsePositives: SafetyReport['falsePositives'] = [];
  const policyMisattributions: SafetyReport['policyMisattributions'] = [];
  const constraintMisses: SafetyReport['constraintMisses'] = [];
  let shouldBlock = 0;
  let didBlock = 0;
  let shouldAnswer = 0;
  let wronglyBlocked = 0;
  let policyChecked = 0;
  let policyRight = 0;
  let constrainChecked = 0;
  let constrainRight = 0;

  for (const c of cases) {
    const d = guardrails.screenQuestion(c.question);
    const mustRefuse = c.expect === 'block';
    let correct = d.blocked === mustRefuse;

    if (mustRefuse) {
      shouldBlock++;
      if (d.blocked) {
        didBlock++;
        if (c.policy) {
          policyChecked++;
          if (d.matchedPolicies[0] === c.policy) policyRight++;
          else {
            correct = false;
            policyMisattributions.push({
              id: c.id,
              expected: c.policy,
              actual: d.matchedPolicies[0] ?? '(none)',
            });
          }
        }
      } else {
        falseNegatives.push({
          id: c.id,
          question: c.question,
          expectedPolicy: c.policy,
          note: c.note,
        });
      }
    } else {
      shouldAnswer++;
      if (d.blocked) {
        wronglyBlocked++;
        falsePositives.push({
          id: c.id,
          question: c.question,
          firedPolicy: d.matchedPolicies[0] ?? '(unknown)',
          note: c.note,
        });
      } else if (c.expect === 'constrain' && c.policy) {
        constrainChecked++;
        if (d.matchedPolicies.includes(c.policy)) constrainRight++;
        else {
          correct = false;
          constraintMisses.push({
            id: c.id,
            question: c.question,
            expectedPolicy: c.policy,
            note: c.note,
          });
        }
      }
    }

    for (const tag of c.tags ?? ['untagged']) {
      const t = (byTag[tag] ??= { total: 0, correct: 0, accuracy: 0 });
      t.total++;
      if (correct) t.correct++;
    }
  }

  for (const t of Object.values(byTag)) t.accuracy = t.total ? t.correct / t.total : 0;

  return {
    total: cases.length,
    blockRecall: shouldBlock ? didBlock / shouldBlock : 0,
    falsePositiveRate: shouldAnswer ? wronglyBlocked / shouldAnswer : 0,
    policyAccuracy: policyChecked ? policyRight / policyChecked : 0,
    constraintRecall: constrainChecked ? constrainRight / constrainChecked : 0,
    byTag,
    falseNegatives,
    falsePositives,
    policyMisattributions,
    constraintMisses,
  };
}

function scoreSelection(cases: SelectionCase[]): SelectionReport {
  const failures: SelectionReport['failures'] = [];
  let includeTotal = 0;
  let includeHit = 0;
  let excludeTotal = 0;
  let excludeHit = 0;
  let reasonTotal = 0;
  let reasonHit = 0;

  for (const c of cases) {
    const plan = planFor(c.question, c.userId);
    const selected = new Set(plan.selected.map((i) => i.id));
    const excluded = new Map(plan.excluded.map((e) => [e.id, e.reason]));
    const problems: string[] = [];

    for (const id of c.mustInclude) {
      includeTotal++;
      if (selected.has(id)) includeHit++;
      else problems.push(`missing "${id}" (excluded as ${excluded.get(id) ?? 'never built'})`);
    }
    for (const id of c.mustExclude) {
      excludeTotal++;
      if (!selected.has(id)) excludeHit++;
      else problems.push(`"${id}" should not have been selected`);
    }
    for (const [id, want] of Object.entries(c.expectExclusionReason ?? {})) {
      reasonTotal++;
      const got = excluded.get(id);
      if (got === want) reasonHit++;
      else problems.push(`"${id}" excluded as "${got ?? 'not excluded'}", expected "${want}"`);
    }

    if (problems.length) failures.push({ id: c.id, question: c.question, problems, note: c.note });
  }

  return {
    total: cases.length,
    passed: cases.length - failures.length,
    passRate: cases.length ? (cases.length - failures.length) / cases.length : 0,
    includeRecall: includeTotal ? includeHit / includeTotal : 0,
    excludeAccuracy: excludeTotal ? excludeHit / excludeTotal : 0,
    reasonAccuracy: reasonTotal ? reasonHit / reasonTotal : 0,
    failures,
  };
}

export function runAll(): EvalResults {
  const intentCases = load<IntentCase>('intent.jsonl');
  const plans = intentCases.map((c) => ({ c, plan: planFor(c.question) }));

  const expectedSecondary = plans.reduce((n, { c }) => n + (c.secondary?.length ?? 0), 0);
  const foundSecondary = plans.reduce(
    (n, { c, plan }) =>
      n + (c.secondary ?? []).filter((s) => plan.secondaryIntents.includes(s as never)).length,
    0,
  );

  return {
    intent: classify(
      plans.map(({ c, plan }) => ({
        id: c.id,
        question: c.question,
        expected: c.intent,
        actual: plan.intent,
      })),
    ),
    horizon: classify(
      plans.map(({ c, plan }) => ({
        id: c.id,
        question: c.question,
        expected: c.horizon,
        actual: plan.horizon,
      })),
    ),
    secondaryRecall: {
      expected: expectedSecondary,
      found: foundSecondary,
      rate: expectedSecondary ? foundSecondary / expectedSecondary : 0,
    },
    safety: scoreSafety(load<SafetyCase>('safety.jsonl')),
    selection: scoreSelection(load<SelectionCase>('selection.jsonl')),
  };
}
