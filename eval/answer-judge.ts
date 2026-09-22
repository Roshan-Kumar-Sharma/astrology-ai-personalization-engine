/**
 * The answer-quality judge: calibrate it, then point it at real answers.
 *
 *   npm run eval:judge                      # calibration: 35 probes, ~35 calls
 *   npm run eval:judge -- --dry-run         # show the probes, call nothing
 *   npm run eval:judge -- --only clean      # one kind of probe
 *   npm run eval:judge -- --limit 2         # first N cases only
 *   npm run eval:judge -- --live 3          # generate 3 real answers, judge them
 *   npm run eval:judge -- --model <slug>    # judge with a different model
 *   npm run eval:judge -- --out run.json    # save the verdicts
 *   npm run eval:judge -- --rescore run.json  # re-score a saved run, no provider
 *
 * Calibration is the number that matters, and it comes first. Each clean,
 * hand-written answer in `eval/dataset/judge.jsonl` is sent as-is and again
 * with one named defect injected - an invented planet, a stated certainty,
 * the wrong language, a broken safety constraint, an answer to a different
 * question. The judge is then scored like any other classifier: recall per
 * defect type, false positives on the clean set, and *collateral* - a defect
 * flagged on a dimension it did not touch. A judge with high recall and high
 * collateral is a judge that fails everything on any defect, which is not a
 * judge.
 *
 * `--live` is the smoke test, not the measurement: real answers from the
 * configured provider, graded, with the deterministic checks alongside so the
 * reader can see where the two agree.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GroundednessService } from '../src/answer/groundedness.service';
import { loadConfig } from '../src/common/config/app.config';
import { StructuredLogger } from '../src/common/logging/logger';
import { LlmProvider } from '../src/llm/llm.provider';
import { createLlmProvider } from '../src/llm/provider.factory';
import { PromptBuilder } from '../src/llm/prompt/prompt.builder';
import { guardrails, planFor } from './harness';
import {
  DIMENSIONS,
  Dimension,
  JudgeCase,
  MUTATIONS,
  Mutation,
  Probe,
  ProbeResult,
  Verdict,
  buildJudgeRequest,
  buildProbes,
  deterministicChecks,
  parseVerdict,
  scoreCalibration,
  summarise,
} from './judge';
import { pct, table } from './metrics';

const arg = (n: string, d?: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i === -1 ? d : (process.argv[i + 1] ?? '');
};
const has = (n: string) => process.argv.includes(`--${n}`);

const dryRun = has('dry-run');
const limit = Number(arg('limit', '0')) || undefined;
const only = arg('only') as Mutation | 'clean' | undefined;
const live = Number(arg('live', '0')) || 0;
const model = arg('model');
const outFile = arg('out');
const rescoreFile = arg('rescore');
/** OpenRouter allows 20 requests/minute on every tier; pace below that. */
const gapMs = Number(arg('gap', '3200'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (only && only !== 'clean' && !MUTATIONS.includes(only)) {
  console.error(`--only must be one of: clean, ${MUTATIONS.join(', ')}`);
  process.exit(1);
}

const CASES: JudgeCase[] = readFileSync(join(__dirname, 'dataset', 'judge.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((l) => JSON.parse(l) as JudgeCase);

const SHORT: Record<Dimension, string> = {
  grounded: 'G',
  hedged: 'H',
  in_scope: 'S',
  language: 'L',
  constrained: 'C',
};

const marks = (v?: Verdict) =>
  v ? DIMENSIONS.map((d) => `${SHORT[d]}${v[d].pass ? '✓' : '✗'}`).join(' ') : '(no verdict)';

/**
 * One retry, and only one. Every attempt here is a real call against a daily
 * cap; a script that retries five times to rescue a measurement can spend the
 * quota the measurement needed.
 */
async function judge(
  provider: LlmProvider,
  probe: Probe,
): Promise<{ verdict?: Verdict; attempts: number }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await provider.generate(buildJudgeRequest(probe.prompt, probe.answer));
      const verdict = parseVerdict(res.text);
      if (verdict) return { verdict, attempts: attempt };
    } catch {
      // fall through to the retry
    }
    if (attempt === 1) await sleep(4000);
  }
  return { attempts: 2 };
}

async function calibrate(provider: LlmProvider | undefined) {
  const probes = buildProbes(CASES, { only, limit });
  const clean = probes.filter((p) => p.kind === 'clean').length;
  console.log(`probes   ${probes.length} (${clean} clean, ${probes.length - clean} mutated)\n`);

  const results: ProbeResult[] = [];
  for (const [i, probe] of probes.entries()) {
    const checks = deterministicChecks(probe);
    const label = `${probe.caseId} ${probe.kind.padEnd(16)}`;

    if (dryRun) {
      const det = [
        `det: grounded ${checks.grounded ? '✓' : '✗'}`,
        `hedged ${checks.hedged ? '✓' : '✗'}`,
        `script ${checks.language === undefined ? '-' : checks.language ? '✓' : '✗'}`,
        `${checks.words}/${probe.plan.style.maxWords}w`,
      ].join(' ');
      console.log(`  [${label}] target=${(probe.target ?? '-').padEnd(11)} ${det}`);
      continue;
    }

    const { verdict, attempts } = await judge(provider!, probe);
    results.push({ probe: summarise(probe), verdict, checks, attempts });

    const flag =
      verdict && probe.target ? (verdict[probe.target].pass ? '  <- MISSED' : '  <- caught') : '';
    console.log(`  [${label}] ${marks(verdict)}${flag}`);
    if (i < probes.length - 1) await sleep(gapMs);
  }
  if (dryRun) {
    console.log(`\n${probes.length} calls would be made. Nothing was sent.\n`);
    return;
  }

  if (outFile) {
    writeFileSync(outFile, JSON.stringify(results, null, 2) + '\n');
    console.log(`\nsaved    ${results.length} results to ${outFile}`);
  }
  report(results);
}

function report(results: ProbeResult[]) {
  const r = scoreCalibration(results);
  console.log();

  if (r.failureRate > 0.25) {
    // Same rule as the safety measurement: a recall figure computed from calls
    // that never landed is a fact about the quota, and it is exactly the kind
    // of number that gets quoted later without its footnote.
    console.log(
      `*** NOT REPORTING CALIBRATION: ${r.failed} of ${r.probes} judge calls failed ` +
        `(${pct(r.failureRate)}). ***\nThe judge was mostly absent, so the numbers would measure ` +
        `the provider, not the judge.\nRe-run when the provider is answering.\n`,
    );
    process.exit(2);
  }

  console.log(
    table(
      ['dimension', 'mutations caught', 'false positives', 'deterministic check'],
      r.perDimension.map((d) => [
        d.dimension === 'constrained'
          ? `constrained (${d.scoredOn} policy-constrained)`
          : d.dimension,
        d.mutated ? `${d.caught}/${d.mutated} (${pct(d.caught / d.mutated)})` : '-',
        `${d.falsePositives}/${d.clean} (${pct(d.falsePositives / d.clean)})`,
        d.deterministicApplicable
          ? `${d.deterministicCaught}/${d.deterministicApplicable} (${pct(
              d.deterministicCaught! / d.deterministicApplicable,
            )})`
          : 'none',
      ]),
    ),
  );

  const totalCaught = r.perDimension.reduce((n, d) => n + d.caught, 0);
  const totalMutated = r.perDimension.reduce((n, d) => n + d.mutated, 0);
  const cleanFlagged = r.falsePositives.length;
  const cleanJudged = r.perDimension[0].clean;
  console.log(
    `\noverall      ${totalCaught}/${totalMutated} defects caught (${pct(totalCaught / totalMutated)}); ` +
      `${cleanFlagged}/${cleanJudged} clean answers wrongly flagged (${pct(cleanFlagged / cleanJudged)})`,
  );
  // Only when every probe recorded its attempts; a partial count would read
  // as a lower failure rate than the provider actually had.
  if (results.every((x) => x.attempts !== undefined))
    console.log(
      `calls        ${r.retried} of ${r.probes} probes needed the one retry ` +
        `(${pct(r.retried / r.probes)} first-attempt failure); ${r.failed} got no verdict at all`,
    );
  else if (r.failed) console.log(`failed       ${r.failed} of ${r.probes} judge calls`);

  const collateral = Object.entries(r.collateral);
  if (collateral.length) {
    console.log('\ncollateral (a defect flagged on a dimension it did not touch):');
    for (const [m, dims] of collateral)
      for (const [d, n] of Object.entries(dims)) {
        const confirmed = r.collateralConfirmed[m]?.[d] ?? 0;
        const note = confirmed ? `  (deterministic check agrees on ${confirmed})` : '';
        console.log(`  ${m.padEnd(17)} -> ${d}: ${n}${note}`);
      }
  }

  if (r.misses.length) {
    console.log('\nMISSED - the defect the judge did not see:');
    for (const m of r.misses)
      console.log(
        `  [${m.probe.caseId} ${m.probe.kind}] ${m.probe.target}: "${m.verdict![m.probe.target!].reason}"`,
      );
  }
  if (r.falsePositives.length) {
    console.log(
      '\nWRONGLY FLAGGED - clean answers the judge failed, the number that decides trust:',
    );
    for (const f of r.falsePositives)
      for (const d of DIMENSIONS)
        if (!f.verdict![d].pass)
          console.log(`  [${f.probe.caseId}] ${d}: "${f.verdict![d].reason}"`);
  }
  console.log();
}

/**
 * Real answers, graded. The pipeline minus HTTP: the same plan and prompt the
 * API would build, the configured provider, the same parse. No calibration
 * numbers come out of this - it is what the judge is *for*, once calibrated.
 */
async function judgeLive(provider: LlmProvider) {
  const builder = new PromptBuilder();
  const groundedness = new GroundednessService();
  const cases = CASES.slice(0, live);
  console.log(`live     ${cases.length} answers generated by ${provider.name}, then judged\n`);

  for (const [i, kase] of cases.entries()) {
    const plan = planFor(kase.question, kase.userId);
    const prompt = builder.build(kase.question, plan);

    let answer: string;
    let generatedBy: string;
    try {
      const gen = await provider.generate(prompt);
      generatedBy = `${gen.provider}/${gen.model}`;
      answer = groundedness.parse(gen.text).answer;
    } catch (err) {
      console.log(`  [${kase.id}] generation failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    await sleep(gapMs);

    const probe: Probe = {
      caseId: kase.id,
      userId: kase.userId,
      question: kase.question,
      kind: 'clean',
      answer,
      plan,
      prompt,
    };
    const checks = deterministicChecks(probe);

    // Print what was generated before spending the judge call: a judge
    // failure must not lose the answer it was about to grade.
    console.log(`  [${kase.id}] ${kase.userId} ${plan.style.languageCode} - "${kase.question}"`);
    console.log(`    generated by ${generatedBy}, ${checks.words}/${plan.style.maxWords} words`);
    console.log(
      `    deterministic: grounded ${checks.grounded ? '✓' : '✗'}  hedged ${checks.hedged ? '✓' : '✗'}  ` +
        `script ${checks.language === undefined ? '-' : checks.language ? '✓' : '✗'}  ` +
        `length ${checks.withinLength ? '✓' : '✗'}`,
    );
    if (!checks.grounded || !checks.hedged) {
      const review = guardrails.reviewAnswer(answer);
      const g = groundedness.verify(
        { answer, citedIds: [], usedFallbackParse: false },
        plan.selected,
      );
      if (g.ungroundedEntities.length)
        console.log(`      ungrounded: ${g.ungroundedEntities.join(', ')}`);
      if (review.violations.length)
        console.log(`      output rules: ${review.violations.join(', ')}`);
    }
    console.log(`    answer: ${answer.replace(/\s+/g, ' ')}\n`);

    const { verdict } = await judge(provider, probe);
    console.log(`    judge:         ${marks(verdict)}`);
    if (verdict)
      for (const d of DIMENSIONS)
        if (!verdict[d].pass) console.log(`      ${d}: "${verdict[d].reason}"`);
    console.log();
    if (i < cases.length - 1) await sleep(gapMs);
  }
}

async function main() {
  const logger = new StructuredLogger();
  logger.setLevel('error');
  const cfg = loadConfig({
    ...process.env,
    ...(model ? { OPENROUTER_MODEL: model, OPENAI_MODEL: model, ANTHROPIC_MODEL: model } : {}),
  });

  if (dryRun) {
    console.log('\ndry run  no provider, no calls');
    await calibrate(undefined);
    return;
  }
  if (rescoreFile) {
    // Either a bare array (what --out writes) or a wrapper with provenance.
    const parsed = JSON.parse(readFileSync(rescoreFile, 'utf8')) as
      ProbeResult[] | { provider?: string; model?: string; date?: string; results: ProbeResult[] };
    const saved = Array.isArray(parsed) ? parsed : parsed.results;
    if (!Array.isArray(parsed) && parsed.provider)
      console.log(`\nprovider ${parsed.provider} / ${parsed.model} (${parsed.date})`);
    console.log(`rescore  ${saved.length} saved results from ${rescoreFile}, no calls`);
    report(saved);
    return;
  }

  const provider = createLlmProvider(cfg, logger);
  if (provider.name === 'mock') {
    console.error(
      '\nRefusing to calibrate a judge against the mock provider - it cannot read.\n' +
        'Set LLM_PROVIDER and the matching API key in .env, or pass --dry-run.\n',
    );
    process.exit(1);
  }
  console.log(`\nprovider ${provider.name} / ${provider.model}`);

  if (live) await judgeLive(provider);
  else await calibrate(provider);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
