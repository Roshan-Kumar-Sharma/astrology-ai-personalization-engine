/**
 * Where should the escalation threshold sit?
 *
 *   npm run eval:gate
 *
 * Costs nothing and calls nothing: it only asks how well the lexicon's own
 * confidence predicts its own correctness. If it does not, there is no gate
 * worth building and the fallback should be on for everything or off entirely.
 *
 * Read the sweep as a cost/benefit curve. Escalating more catches more errors
 * and costs more calls; the useful threshold is the knee, not the maximum.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IntentClassifier } from '../src/personalization/intent/intent.classifier';
import { pct, table } from './metrics';
import type { IntentCase } from './score';

const classifier = new IntentClassifier();
const cases = readFileSync(join(__dirname, 'dataset', 'intent.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as IntentCase);

const rows = cases.map((c) => {
  const r = classifier.classify(c.question);
  return { conf: r.confidence, method: r.method, ok: r.intent === c.intent };
});

const acc = (sub: typeof rows) => (sub.length ? sub.filter((r) => r.ok).length / sub.length : 0);

console.log('\nIs the confidence calibrated?\n');
console.log(
  table(
    ['classifier said', 'questions', 'accuracy'],
    ['lexicon', 'default'].map((m) => {
      const s = rows.filter((r) => r.method === m);
      return [m, s.length, pct(acc(s))];
    }),
  ),
);

console.log('\nAccuracy by confidence band\n');
console.log(
  table(
    ['confidence', 'questions', 'accuracy'],
    (
      [
        [0, 0.4],
        [0.4, 0.6],
        [0.6, 0.8],
        [0.8, 0.9],
        [0.9, 1.01],
      ] as const
    )
      .map(([lo, hi]) => {
        const s = rows.filter((r) => r.conf >= lo && r.conf < hi);
        return s.length
          ? [`${lo.toFixed(2)} - ${hi === 1.01 ? '1.00' : hi.toFixed(2)}`, s.length, pct(acc(s))]
          : undefined;
      })
      .filter((r): r is (string | number)[] => !!r),
  ),
);

const wrong = rows.filter((r) => !r.ok).length;
console.log('\nGate sweep: escalate when confidence < T\n');
console.log(
  table(
    ['T', 'escalated', 'of traffic', 'errors caught', 'errors left', 'gate precision'],
    [0.35, 0.4, 0.5, 0.6, 0.7, 0.8, 0.86, 0.88, 0.9, 0.99].map((t) => {
      const esc = rows.filter((r) => r.conf < t);
      const caught = esc.filter((r) => !r.ok).length;
      return [
        t.toFixed(2),
        esc.length,
        pct(esc.length / rows.length),
        `${caught}/${wrong}`,
        wrong - caught,
        esc.length ? pct(caught / esc.length) : '-',
      ];
    }),
  ),
);
console.log(
  '\ngate precision = share of escalated questions the lexicon actually got wrong,\n' +
    'i.e. the share of the LLM calls that had any chance of helping.\n',
);
