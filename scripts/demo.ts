/**
 * Scenario walkthrough.
 *
 * Exercises the behaviours that are hard to see from a single curl: the time
 * horizon changing what gets selected, the safety layer, degradation when the
 * birth time is unusable, and the token cost of selection versus sending
 * everything.
 *
 * Usage:  npm run demo          (server must already be running on PORT)
 */

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3000';

interface PersonalizeResponse {
  answer: string;
  confidence: string;
  sourcesUsed: string[];
  meta?: Record<string, any>;
}

async function personalize(userId: string, question: string, verbose = false) {
  const res = await fetch(`${BASE}/personalize`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, question, verbose }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as PersonalizeResponse;
}

async function explain(userId: string, question: string) {
  const res = await fetch(`${BASE}/debug/personalization`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId, question }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return (await res.json()) as any;
}

function heading(title: string) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`);
}

function sub(title: string) {
  console.log(`\n-- ${title} ${'-'.repeat(Math.max(0, 74 - title.length))}`);
}

async function main() {
  // ---------------------------------------------------------------------------
  heading("1. THE BRIEF'S EXAMPLE REQUEST");
  const flagship = await personalize(
    'user_101',
    'Should I consider changing my job in the next few months?',
    true,
  );
  console.log(flagship.answer);
  console.log(`\nconfidence : ${flagship.confidence}`);
  console.log(`sourcesUsed: ${JSON.stringify(flagship.sourcesUsed)}`);
  console.log(
    `tokens     : ${flagship.meta?.tokens.contextSelected} of ${flagship.meta?.tokens.contextAvailable} available ` +
      `(${flagship.meta?.tokens.contextSavedPct}% of candidate context withheld)`,
  );

  // ---------------------------------------------------------------------------
  heading('2. TIME HORIZON CHANGES WHAT IS RELEVANT');
  console.log('The same career question, asked over four different windows.\n');
  for (const phrase of ['today', 'this week', 'in the next few months', 'this year']) {
    const r = await explain('user_101', `Should I consider changing my job ${phrase}?`);
    const panchang = r.selectedContext.filter((s: string) => /panchang|nakshatra/i.test(s));
    console.log(`  "${phrase}"`.padEnd(28) + `horizon=${r.explain.timeHorizon.horizon.padEnd(9)}`);
    console.log(`  ${' '.repeat(26)}top 4: ${r.selectedContext.slice(0, 4).join(', ')}`);
    console.log(
      `  ${' '.repeat(26)}panchang present: ${panchang.length ? panchang.join(', ') : 'no'}`,
    );
    console.log();
  }

  // ---------------------------------------------------------------------------
  heading('3. SAFETY LAYER');
  const risky: [string, string][] = [
    ['death timing', 'When will I die?'],
    ['medical prognosis', "Will my mother's cancer be cured?"],
    ['prenatal sex (illegal in India)', 'Will my baby be a boy or a girl?'],
    ['self-harm', "I don't want to live anymore, what does my chart say?"],
    ['harm to others', 'Give me a vashikaran mantra to control my ex'],
  ];
  for (const [label, question] of risky) {
    const r = await personalize('user_101', question, true);
    console.log(`\n  [BLOCKED: ${label}]  "${question}"`);
    console.log(`  policy: ${JSON.stringify(r.meta?.policies)}`);
    console.log(`  ${r.answer.split('\n')[0].slice(0, 100)}...`);
  }

  sub('Constrained (not blocked) - the LLM runs, with injected restrictions');
  for (const question of [
    'Should I buy Tata Motors stock this month?',
    'Is my husband cheating on me?',
    'Will I win my court case this year?',
  ]) {
    const r = await explain('user_101', question);
    console.log(`\n  "${question}"`);
    console.log(`  policies: ${JSON.stringify(r.explain.safety.policies)}`);
    for (const c of r.explain.safety.injectedConstraints.slice(4)) {
      console.log(`    + ${c}`);
    }
  }

  // ---------------------------------------------------------------------------
  heading('4. DEGRADATION: BIRTH TIME RELIABILITY');
  console.log(
    'user_101 has an exact birth time. user_103 has none, so the ascendant and\n' +
      'every house placement are unreliable and must not be used.\n',
  );
  for (const userId of ['user_101', 'user_102', 'user_103']) {
    const r = await explain(userId, 'What should I focus on for my health?');
    const rel = r.explain.chartReliability;
    const houses = r.selectedContext.filter((s: string) => /House|Lagna|Ascendant/.test(s));
    console.log(
      `  ${userId}: birthTime=${rel.birthTime.padEnd(12)} housesUsable=${String(rel.housesUsable).padEnd(6)} confidence=${r.explain.projectedConfidence.label}`,
    );
    console.log(
      `            house-based context sent: ${houses.length ? houses.join(', ') : 'NONE (Moon-sign fallback)'}`,
    );
    console.log(`            language=${r.language}  tone=${r.tone}`);
    console.log();
  }

  // ---------------------------------------------------------------------------
  heading('5. WHERE THE TOKEN BUDGET GOES');
  const questions = [
    'Should I consider changing my job in the next few months?',
    'How does this month look for my relationship?',
    'What should I focus on for my health?',
    'What should I prioritize this week?',
    "Can you summarize today's guidance?",
    'Is this a good time to invest my savings?',
  ];
  let used = 0;
  let candidates = 0;
  let rawDump = 0;
  console.log('  question'.padEnd(50) + 'intent'.padEnd(14) + '  sent  cand.  rawJSON');
  console.log('  ' + '-'.repeat(76));
  for (const question of questions) {
    const r = await explain('user_101', question);
    const t = r.explain.tokenBudget;
    used += t.contextTokensUsed;
    candidates += t.contextTokensAvailable;
    rawDump += t.naiveRawJsonDumpTokens;
    console.log(
      `  ${question.slice(0, 46).padEnd(48)}${r.intent.padEnd(14)}` +
        `${String(t.contextTokensUsed).padStart(6)}${String(t.contextTokensAvailable).padStart(7)}${String(t.naiveRawJsonDumpTokens).padStart(9)}`,
    );
  }
  console.log('  ' + '-'.repeat(76));
  console.log(
    `  TOTAL${' '.repeat(57)}${String(used).padStart(6)}${String(candidates).padStart(7)}${String(rawDump).padStart(9)}`,
  );
  console.log(`
  sent    - context actually placed in the prompt
  cand.   - every context item the engine could have sent for this user
  rawJSON - what dumping the four upstream payloads verbatim would cost

  Selection removes ${Math.round((1 - used / candidates) * 100)}% of the candidate set, and excluded items are absent
  from the prompt entirely rather than ranked lower.

  Note the honest part: total prompt size is comparable to a raw JSON dump
  (${used} vs ${rawDump} tokens). This engine does not win by sending less - it wins by
  sending different things. The budget is spent on derived conclusions the raw
  payload does not contain (where the user stands in an 18-year dasha, which
  houses the sub-period lord governs) instead of on fields irrelevant to the
  question. Volume traded for grounding, deliberately.`);

  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error('\nDemo failed:', err.message);
  console.error('Is the server running?  npm start');
  process.exit(1);
});
