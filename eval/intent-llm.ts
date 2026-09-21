/**
 * Measures what the LLM intent fallback actually buys.
 *
 *   npm run eval:intent-llm              # full escalated subset
 *   npm run eval:intent-llm -- --limit 10
 *   npm run eval:intent-llm -- --threshold 0.6
 *
 * This is the only part of the eval that spends money, which is why it is a
 * separate command and not part of `npm run eval` or the CI gate.
 *
 * The number that decides whether to ship is not "how accurate is the LLM" -
 * it is **lift**, and specifically the balance between questions the model
 * fixes and questions it breaks. A classifier that fixes nine and breaks eight
 * is noise with a bill attached.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/common/config/app.config';
import { StructuredLogger } from '../src/common/logging/logger';
import { RequestTrace } from '../src/common/logging/request-trace';
import { createLlmProvider } from '../src/llm/provider.factory';
import { IntentClassifier } from '../src/personalization/intent/intent.classifier';
import { IntentResolver } from '../src/personalization/intent/intent.resolver';
import { pct, table } from './metrics';
import type { IntentCase } from './score';

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const threshold = Number(arg('threshold', '0.35'));
const limit = Number(arg('limit', '0')) || Infinity;
/** OpenRouter allows 20 requests/minute on every tier, so pace below that. */
const gapMs = Number(arg('gap', '3200'));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Retry, here only.
 *
 * `IntentResolver` deliberately does not retry: it sits on the critical path
 * with a 4s budget and a perfectly good lexicon answer already in hand, so
 * failing fast is correct there. This script is offline and is trying to measure
 * what the *model* can do, not what a saturated free tier happened to allow, so
 * it backs off and tries again.
 */
async function withRetries<T>(
  attempts: number,
  fn: () => Promise<T>,
  ok: (v: T) => boolean,
): Promise<T> {
  let last = await fn();
  for (let i = 1; i < attempts && !ok(last); i++) {
    await sleep(2000 * 2 ** i);
    last = await fn();
  }
  return last;
}

async function main() {
  const logger = new StructuredLogger();
  logger.setLevel('error');
  const cfg = loadConfig({
    ...process.env,
    INTENT_LLM_FALLBACK: 'true',
    INTENT_LLM_THRESHOLD: String(threshold),
  });
  const provider = createLlmProvider(cfg, logger);

  if (provider.name === 'mock') {
    console.error(
      '\nRefusing to report a lift measured against the mock provider.\n' +
        'Set LLM_PROVIDER and the matching API key in .env first.\n',
    );
    process.exit(1);
  }

  const lexicon = new IntentClassifier();
  const resolver = new IntentResolver(cfg, provider, lexicon, logger);

  const cases = readFileSync(join(__dirname, 'dataset', 'intent.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as IntentCase);

  const baseline = cases.map((c) => ({ c, lex: lexicon.classify(c.question) }));
  const escalated = baseline.filter((r) => r.lex.confidence < threshold).slice(0, limit);

  console.log(`\nprovider ${provider.name} / ${provider.model}`);
  console.log(`gate     confidence < ${threshold}`);
  console.log(
    `subset   ${escalated.length} of ${cases.length} questions (${pct(escalated.length / cases.length)} of traffic)\n`,
  );

  let fixed = 0;
  let broken = 0;
  let unchangedWrong = 0;
  let unchangedRight = 0;
  let failed = 0;
  const changes: {
    id: string;
    question: string;
    from: string;
    to: string;
    want: string;
    verdict: string;
  }[] = [];

  for (const [i, row] of escalated.entries()) {
    const res = await withRetries(
      3,
      () => resolver.resolve(row.c.question, new RequestTrace('eval')),
      (r) => r.method === 'llm',
    );
    const lexOk = row.lex.intent === row.c.intent;
    const newOk = res.intent === row.c.intent;

    if (res.method !== 'llm') failed++;
    if (!lexOk && newOk) fixed++;
    else if (lexOk && !newOk) broken++;
    else if (lexOk) unchangedRight++;
    else unchangedWrong++;

    if (row.lex.intent !== res.intent) {
      changes.push({
        id: row.c.id,
        question: row.c.question,
        from: row.lex.intent,
        to: res.intent,
        want: row.c.intent,
        verdict: !lexOk && newOk ? 'FIXED' : lexOk && !newOk ? 'BROKE' : 'still wrong',
      });
    }
    process.stderr.write(`\r  ${i + 1}/${escalated.length}`);
    if (i < escalated.length - 1) await sleep(gapMs);
  }
  process.stderr.write('\r                    \r');

  const n = escalated.length;
  const lexRight = escalated.filter((r) => r.lex.intent === r.c.intent).length;
  const llmRight = lexRight + fixed - broken;

  console.log(
    table(
      ['on the escalated subset', 'count', 'share'],
      [
        ['lexicon correct', lexRight, pct(lexRight / n)],
        ['with fallback correct', llmRight, pct(llmRight / n)],
        ['fixed (wrong -> right)', fixed, pct(fixed / n)],
        ['broke (right -> wrong)', broken, pct(broken / n)],
        ['still wrong', unchangedWrong, pct(unchangedWrong / n)],
        ['model call failed or unparseable', failed, pct(failed / n)],
      ],
    ),
  );

  const before = baseline.filter((r) => r.lex.intent === r.c.intent).length;
  const after = before + fixed - broken;
  console.log(`\noverall accuracy  ${pct(before / cases.length)} -> ${pct(after / cases.length)}`);
  const lift = (after - before) / cases.length;
  console.log(
    `lift              ${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)} points  (net ${fixed - broken} questions over ${n} calls)`,
  );

  if (changes.length) {
    console.log('\nchanged classifications:');
    for (const c of changes) {
      console.log(`  [${c.verdict}] ${c.from} -> ${c.to} (want ${c.want})`);
      console.log(`      "${c.question}"`);
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
