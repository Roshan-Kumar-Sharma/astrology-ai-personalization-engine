/**
 * Probes candidate OpenRouter free models against the real prompt this service
 * builds, and reports which ones are actually usable.
 *
 * "Free" is necessary but not sufficient. What matters here is whether a model
 * follows the JSON output contract, stays inside the supplied context, and
 * writes in the requested language. Picking a default by reputation rather than
 * by measurement is how you ship a provider that silently returns prose where
 * the parser expects an object.
 *
 * Usage: npx ts-node scripts/try-models.ts
 */
import { readFileSync } from 'node:fs';
import { GroundednessService } from '../src/answer/groundedness.service';

const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);

const KEY = env.OPENROUTER_API_KEY;
if (!KEY) throw new Error('OPENROUTER_API_KEY missing from .env');

const CANDIDATES = [
  'z-ai/glm-5.2:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'minimax/minimax-m2.7:free',
  'thinkingmachines/inkling:free',
  'minimax/minimax-m3:free',
];

const SYSTEM = `You are an experienced Vedic astrologer writing for a user of the MyNaksh app.
Use ONLY the astrological context supplied in the CONTEXT block. Never invent placements or dates.
Describe tendencies and timing, never verdicts.

RESPONSE STYLE
Tone: motivational
Length: at most 150 words.

OUTPUT FORMAT
Reply with a single JSON object and nothing else:
{"answer": "<your answer text>", "usedContextIds": ["<ids from the CONTEXT block you actually relied on>"]}`;

const USER = `CONTEXT
[derived.dasha.position] Current Dasha: Rahu mahadasha (18 years), currently the 9th of nine sub-periods: Mars antardasha, about 12.6 months long.
[derived.dasha.transition] Dasha Transition: This is the closing sub-period of the Rahu mahadasha. A Jupiter mahadasha begins next, so this is a genuine chapter boundary.
[derived.house.10] 10th House: House 10 (career, profession, status) falls in Cancer, ruled by Moon, reported as strong.
[horoscope.career] Career Horoscope: Networking may bring new opportunities.

USER QUESTION
Should I consider changing my job in the next few months?`;

const ALLOWED = ['rahu', 'mars', 'jupiter', 'moon', 'cancer'];
const grounded = new GroundednessService();

async function probe(model: string) {
  const t0 = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${KEY}`,
        'HTTP-Referer': 'https://github.com/mynaksh/context-engine',
        'X-Title': 'MyNaksh Context Engine',
      },
      body: JSON.stringify({
        model,
        max_tokens: 600,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: USER },
        ],
      }),
    });

    const ms = Date.now() - t0;
    const body: any = await res.json();
    if (!res.ok || body.error) {
      return {
        model,
        ok: false,
        ms,
        note: `${res.status} ${body?.error?.message ?? ''}`.slice(0, 70),
      };
    }

    const raw = body.choices?.[0]?.message?.content ?? '';
    if (!raw.trim()) return { model, ok: false, ms, note: 'empty content' };

    const parsed = grounded.parse(raw);
    // Crude groundedness proxy: any planet/sign named that we did not supply.
    const lower = parsed.answer.toLowerCase();
    const invented = [
      'venus',
      'saturn',
      'mercury',
      'ketu',
      'sun',
      'libra',
      'scorpio',
      'aries',
    ].filter((w) => new RegExp(`\\b${w}\\b`).test(lower));

    return {
      model,
      ok: true,
      ms,
      json: !parsed.usedFallbackParse,
      cited: parsed.citedIds.length,
      words: parsed.answer.split(/\s+/).length,
      invented,
      preview: parsed.answer.replace(/\s+/g, ' ').slice(0, 100),
    };
  } catch (err: any) {
    return { model, ok: false, ms: Date.now() - t0, note: err.message.slice(0, 70) };
  }
}

async function main() {
  console.log(`Probing ${CANDIDATES.length} free models against the real prompt shape.\n`);
  console.log(
    `${'model'.padEnd(42)} ${'ok'} ${'json'} ${'cite'} ${'words'} ${'ms'.padStart(6)}  invented`,
  );
  console.log('-'.repeat(100));
  for (const model of CANDIDATES) {
    const r: any = await probe(model);
    if (!r.ok) {
      console.log(
        `${model.padEnd(42)} ${'FAIL'.padEnd(4)} ${''.padEnd(19)} ${String(r.ms).padStart(6)}  ${r.note}`,
      );
    } else {
      console.log(
        `${model.padEnd(42)} ${'ok'.padEnd(3)} ${String(r.json).padEnd(5)} ${String(r.cited).padEnd(4)} ${String(r.words).padEnd(5)} ${String(r.ms).padStart(6)}  ${r.invented.length ? r.invented.join(',') : '-'}`,
      );
      console.log(`${' '.repeat(4)}"${r.preview}..."`);
    }
    await new Promise((r) => setTimeout(r, 1200)); // stay under 20 RPM
  }
}

main();
