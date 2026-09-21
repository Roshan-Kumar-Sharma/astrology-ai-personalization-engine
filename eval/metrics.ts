/**
 * Scoring primitives for the golden eval.
 *
 * Deliberately dependency-free and tiny: a metric you cannot read in one sitting
 * is a metric nobody trusts when it moves.
 */

export interface ClassStats {
  label: string;
  support: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface ClassificationReport {
  total: number;
  correct: number;
  accuracy: number;
  perClass: ClassStats[];
  /** actual -> predicted -> count. Only non-empty rows are kept. */
  confusion: Record<string, Record<string, number>>;
  misses: { id: string; question: string; expected: string; actual: string }[];
}

const div = (n: number, d: number) => (d === 0 ? 0 : n / d);

export function classify(
  cases: { id: string; question: string; expected: string; actual: string }[],
): ClassificationReport {
  const labels = [...new Set(cases.flatMap((c) => [c.expected, c.actual]))].sort();
  const confusion: Record<string, Record<string, number>> = {};
  for (const c of cases) {
    (confusion[c.expected] ??= {})[c.actual] = ((confusion[c.expected] ?? {})[c.actual] ?? 0) + 1;
  }

  const perClass = labels.map((label) => {
    const tp = cases.filter((c) => c.expected === label && c.actual === label).length;
    const fp = cases.filter((c) => c.expected !== label && c.actual === label).length;
    const fn = cases.filter((c) => c.expected === label && c.actual !== label).length;
    const precision = div(tp, tp + fp);
    const recall = div(tp, tp + fn);
    return {
      label,
      support: tp + fn,
      tp,
      fp,
      fn,
      precision,
      recall,
      f1: div(2 * precision * recall, precision + recall),
    };
  });

  const correct = cases.filter((c) => c.expected === c.actual).length;
  return {
    total: cases.length,
    correct,
    accuracy: div(correct, cases.length),
    perClass,
    confusion,
    misses: cases.filter((c) => c.expected !== c.actual),
  };
}

/** `-` rather than `NaN%` for an empty denominator, which reads as a bug. */
export const pct = (n: number) => (Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '-');

/** Left-aligned first column, right-aligned numerics. */
export function table(headers: string[], rows: (string | number)[][]): string {
  const all = [headers, ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? '').length)));
  const line = (r: (string | number)[]) =>
    r
      .map((c, i) => (i === 0 ? String(c).padEnd(widths[i]) : String(c).padStart(widths[i])))
      .join('  ');
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n');
}

/** Confusion matrix as a grid; blanks read better than zeros at a glance. */
export function confusionTable(report: ClassificationReport): string {
  const labels = [
    ...new Set([...Object.keys(report.confusion), ...report.perClass.map((c) => c.label)]),
  ]
    .filter((l) => report.perClass.find((c) => c.label === l)?.support || report.confusion[l])
    .sort();
  const headers = ['actual \\ pred', ...labels];
  const rows = labels.map((a) => [a, ...labels.map((p) => report.confusion[a]?.[p] || '')]);
  return table(headers, rows);
}
