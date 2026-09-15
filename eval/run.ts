/**
 * Prints the golden-eval report.
 *
 *   npm run eval            human-readable report
 *   npm run eval -- --json  machine-readable, for tracking numbers over time
 */
import { EvalResults, runAll } from './score';
import { confusionTable, pct, table } from './metrics';

const h = (s: string) => `\n${s}\n${'='.repeat(s.length)}`;

function report(r: EvalResults): string {
  const out: string[] = [];

  out.push(h('Intent classification'));
  out.push(`accuracy ${pct(r.intent.accuracy)}  (${r.intent.correct}/${r.intent.total})`);
  out.push('');
  out.push(
    table(
      ['intent', 'support', 'precision', 'recall', 'f1'],
      r.intent.perClass
        .filter((c) => c.support)
        .map((c) => [c.label, c.support, pct(c.precision), pct(c.recall), c.f1.toFixed(2)]),
    ),
  );
  out.push('');
  out.push(confusionTable(r.intent));
  if (r.intent.misses.length) {
    out.push('\nmisses:');
    for (const m of r.intent.misses) out.push(`  ${m.expected} -> ${m.actual}  "${m.question}"`);
  }

  out.push(h('Horizon extraction'));
  out.push(`accuracy ${pct(r.horizon.accuracy)}  (${r.horizon.correct}/${r.horizon.total})`);
  out.push('');
  out.push(confusionTable(r.horizon));
  if (r.horizon.misses.length) {
    out.push('\nmisses:');
    for (const m of r.horizon.misses) out.push(`  ${m.expected} -> ${m.actual}  "${m.question}"`);
  }

  out.push(h('Secondary intents'));
  out.push(
    `recall ${pct(r.secondaryRecall.rate)}  (${r.secondaryRecall.found}/${r.secondaryRecall.expected} expected secondaries detected)`,
  );

  const s = r.safety;
  out.push(h('Safety'));
  out.push(`block recall        ${pct(s.blockRecall)}   share of unsafe questions stopped`);
  out.push(
    `false positive rate ${pct(s.falsePositiveRate)}   share of safe questions wrongly refused`,
  );
  out.push(
    `policy accuracy     ${pct(s.policyAccuracy)}   right policy cited, among correct blocks`,
  );
  out.push(
    `constraint recall   ${pct(s.constraintRecall)}   constrain-action policies that attached`,
  );
  out.push('');
  out.push(
    table(
      ['subset', 'cases', 'correct', 'accuracy'],
      Object.entries(s.byTag).map(([t, v]) => [t, v.total, v.correct, pct(v.accuracy)]),
    ),
  );
  if (s.falseNegatives.length) {
    out.push('\nlet through (should have been blocked):');
    for (const f of s.falseNegatives) {
      out.push(`  [${f.id}] "${f.question}"`);
      if (f.note) out.push(`      ${f.note}`);
    }
  }
  if (s.falsePositives.length) {
    out.push('\nwrongly refused (should have been answered):');
    for (const f of s.falsePositives) out.push(`  [${f.id}] ${f.firedPolicy}: "${f.question}"`);
  }
  if (s.constraintMisses.length) {
    out.push('\nno constraint attached (should have been answered under one):');
    for (const m of s.constraintMisses)
      out.push(`  [${m.id}] ${m.expectedPolicy}: "${m.question}"`);
  }
  if (s.policyMisattributions.length) {
    out.push('\nblocked, but attributed to the wrong policy:');
    for (const m of s.policyMisattributions)
      out.push(`  [${m.id}] expected ${m.expected}, got ${m.actual}`);
  }

  const sel = r.selection;
  out.push(h('Context selection'));
  out.push(`cases passed        ${pct(sel.passRate)}   (${sel.passed}/${sel.total})`);
  out.push(`include recall      ${pct(sel.includeRecall)}   required items actually sent`);
  out.push(`exclude accuracy    ${pct(sel.excludeAccuracy)}   forbidden items kept out`);
  out.push(`exclusion reasons   ${pct(sel.reasonAccuracy)}   dropped for the right reason`);
  if (sel.failures.length) {
    out.push('\nfailures:');
    for (const f of sel.failures) {
      out.push(`  [${f.id}] "${f.question}"`);
      for (const p of f.problems) out.push(`      - ${p}`);
      if (f.note) out.push(`      note: ${f.note}`);
    }
  }

  return out.join('\n');
}

const results = runAll();
console.log(process.argv.includes('--json') ? JSON.stringify(results, null, 2) : report(results));
