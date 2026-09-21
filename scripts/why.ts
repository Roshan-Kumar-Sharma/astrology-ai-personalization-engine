/**
 * Explain a guardrail decision, pattern by pattern.
 *
 *   npm run why -- "Will my father pass away soon?"
 *
 * `screenQuestion` tells you *that* a policy matched. When you are changing
 * patterns you need to know *which* one, and which ones nearly did - so this
 * re-runs every policy's regexes individually and prints the winner, the
 * runners-up, and the exact substring that matched.
 */
import { RISK_POLICIES, RiskPolicy } from '../src/safety/policies.config';
import { GuardrailsService } from '../src/safety/guardrails.service';

const question = process.argv.slice(2).join(' ').trim();
if (!question) {
  console.error('usage: npm run why -- "<question>"');
  process.exit(1);
}

/** Same normalisation the service applies before matching. */
const q = question.normalize('NFKC').replace(/\s+/g, ' ').trim();

function hits(p: RiskPolicy): { kind: string; re: string; match: string }[] {
  const out: { kind: string; re: string; match: string }[] = [];
  p.patterns.forEach((re) => {
    const m = re.exec(q);
    if (m) out.push({ kind: 'patterns', re: String(re), match: m[0] });
  });
  (p.allOf ?? []).forEach((group, i) => {
    const m = group.map((re) => re.exec(q)).find(Boolean);
    if (m)
      out.push({ kind: `allOf[${i}]`, re: String(group.find((re) => re.test(q))), match: m[0] });
  });
  return out;
}

/** allOf is all-or-nothing: a partial hit explains a *near* miss. */
function allOfSatisfied(p: RiskPolicy): boolean | null {
  if (!p.allOf?.length) return null;
  return p.allOf.every((group) => group.some((re) => re.test(q)));
}

const decision = new GuardrailsService().screenQuestion(question);

console.log(`\nQuestion: ${question}`);
console.log(`Decision: ${decision.blocked ? 'BLOCKED' : 'ALLOWED'}`);
console.log(`Policies: ${decision.matchedPolicies.join(', ') || '(none)'}\n`);

const sorted = [...RISK_POLICIES].sort((a, b) => b.priority - a.priority);
for (const p of sorted) {
  const h = hits(p);
  if (!h.length) continue;

  const anyOf = h.some((x) => x.kind === 'patterns');
  const all = allOfSatisfied(p);
  const fires = anyOf || all === true;
  const mark = fires
    ? p.action === 'block'
      ? 'FIRES (block)'
      : 'FIRES (constrain)'
    : 'partial - does not fire';

  console.log(`${p.id}  [priority ${p.priority}]  ${mark}`);
  for (const x of h) console.log(`    ${x.kind}  matched "${x.match}"\n      ${x.re}`);
  if (all === false) console.log(`    allOf not satisfied: every group must hit, and one did not.`);
  console.log();
}

if (!sorted.some((p) => hits(p).length)) console.log('No policy matched any pattern.\n');
