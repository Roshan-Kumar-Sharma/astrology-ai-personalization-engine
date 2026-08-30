import { Injectable } from '@nestjs/common';
import { LlmProvider, LlmRequest, LlmResponse } from '../llm.provider';
import { estimateTokens } from '../tokenizer';

/**
 * Deterministic offline provider.
 *
 * Not a stub that returns "lorem ipsum". It parses the CONTEXT block out of the
 * prompt and composes an answer from the items it was actually given, which
 * means the whole pipeline - selection, grounding, source verification,
 * confidence - can be exercised and tested end to end with no API key and no
 * network. Deterministic output also makes integration tests assertable.
 *
 * Honest limitation: it composes English prose only. It does not translate, so
 * language personalization is verified through the prompt (visible via
 * /debug/personalization) and through the live providers, not through this one.
 */
@Injectable()
export class MockLlmProvider implements LlmProvider {
  readonly name = 'mock';
  readonly model = 'mock-astrologer-v1';

  async generate(req: LlmRequest): Promise<LlmResponse> {
    const started = performance.now();
    const items = parseContext(req.messages.map((m) => m.content).join('\n'));
    const question = parseQuestion(req.messages.map((m) => m.content).join('\n'));
    const tone = detectTone(req.systemDynamic);
    const intent = detectIntent(req.systemDynamic);
    const maxWords = detectMaxWords(req.systemDynamic);

    const answer = compose({ items, question, tone, intent, maxWords });
    const used = items.slice(0, 4).map((i) => i.id);

    const text = JSON.stringify({ answer, usedContextIds: used });

    return {
      text,
      model: this.model,
      provider: this.name,
      usage: {
        inputTokens: estimateTokens(req.systemStatic + req.systemDynamic + question),
        outputTokens: estimateTokens(text),
      },
      latencyMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }
}

interface ParsedItem {
  id: string;
  label: string;
  text: string;
}

function parseContext(prompt: string): ParsedItem[] {
  const out: ParsedItem[] = [];
  for (const line of prompt.split('\n')) {
    const m = /^\[([\w.]+)\]\s+([^:]+):\s+(.*)$/.exec(line.trim());
    if (m) out.push({ id: m[1], label: m[2], text: m[3] });
  }
  return out;
}

function parseQuestion(prompt: string): string {
  const idx = prompt.indexOf('USER QUESTION');
  return idx < 0 ? '' : prompt.slice(idx + 'USER QUESTION'.length).trim();
}

function detectTone(system: string): string {
  const m = /^Tone: (\w+)/m.exec(system);
  return m ? m[1].toLowerCase() : 'neutral';
}

function detectIntent(system: string): string {
  const m = /asking a (\w+) question/.exec(system);
  return m ? m[1] : 'general';
}

function detectMaxWords(system: string): number {
  const m = /at most (\d+) words/.exec(system);
  return m ? Number(m[1]) : 200;
}

const OPENERS: Record<string, Record<string, string>> = {
  motivational: {
    career: 'This is a genuinely workable moment to be asking about your work.',
    relationship: 'There is real room to move in this area right now.',
    health: 'Your energy is something you can actively shape in this period.',
    finance: 'This is a sensible time to be thinking carefully about money.',
    daily: 'Here is what today is actually asking of you.',
    general: 'There is a clear thread running through your chart at the moment.',
  },
  gentle: {
    career: 'It makes sense that work is on your mind right now.',
    relationship: 'This is a tender area, and your chart reflects that.',
    health: 'Be kind to yourself here - your chart suggests you need it.',
    finance: 'Money questions can feel heavy, so let us take this gently.',
    daily: 'Today asks for something quite modest of you.',
    general: 'Let us look at this calmly.',
  },
  // Openers must not assert anything about the chart. During development the
  // analytical opener named "the sixth house", and the groundedness verifier
  // correctly flagged it for a user whose birth time was unknown and whose house
  // context had therefore been withheld - a hallucination introduced by the
  // generator rather than by the data, which is precisely what that check is for.
  analytical: {
    career:
      'The career reading here rests on two things: the period you are running, and how strongly work is supported in your chart.',
    relationship:
      'The relationship reading turns on the running period and how partnership sits in your chart.',
    health: 'Health here is read from your underlying vitality alongside the running period.',
    finance: 'The financial reading comes from how income and accumulation are placed for you.',
    daily: 'Today reads as follows.',
    general: 'The dominant factor in your chart right now is the period you are running.',
  },
  direct: {
    career: 'Short answer: the timing is meaningful, but move deliberately.',
    relationship: 'Short answer: this period supports honest conversation more than big decisions.',
    health: 'Short answer: routine matters more than anything dramatic right now.',
    finance: 'Short answer: consolidate before you expand.',
    daily: 'Today: keep it simple.',
    general: 'Short answer: you are between chapters.',
  },
  neutral: {
    career: 'Your chart has something specific to say about work at the moment.',
    relationship: 'Your chart speaks to this area fairly clearly right now.',
    health: 'Your chart points to a few practical things on health.',
    finance: 'Your chart suggests a particular financial posture right now.',
    daily: 'Here is how today reads.',
    general: 'Here is what stands out in your chart right now.',
  },
};

const CLOSERS: Record<string, string> = {
  motivational:
    'None of this decides anything for you - it describes the conditions you are working in. The move itself is yours to make.',
  gentle:
    'Take this as a description of the weather, not a verdict. You get to choose how you walk through it.',
  analytical:
    'These are indications, not outcomes. Weigh them against what you actually know about your situation.',
  direct: 'That is the reading. The decision stays yours.',
  neutral: 'The chart describes conditions, not conclusions. The decision remains yours.',
};

function compose(input: {
  items: ParsedItem[];
  question: string;
  tone: string;
  intent: string;
  maxWords: number;
}): string {
  const { items, tone, intent, maxWords } = input;
  const toneKey = OPENERS[tone] ? tone : 'neutral';

  if (!items.length) {
    return 'I could not retrieve enough of your chart to answer this properly. Please try again shortly - I would rather say nothing than guess.';
  }

  const opener = OPENERS[toneKey][intent] ?? OPENERS[toneKey].general;

  // Weave the actual context in, leading with the derived conclusions because
  // they carry the most information per sentence.
  const ordered = [
    ...items.filter((i) => i.id.startsWith('derived.')),
    ...items.filter((i) => !i.id.startsWith('derived.')),
  ];

  const body = ordered
    .slice(0, 4)
    .map((i) => sentenceFor(i))
    .filter(Boolean);
  const paragraphs = [opener, body.join(' '), CLOSERS[toneKey]];

  return trimToWords(paragraphs.join('\n\n'), maxWords);
}

function sentenceFor(item: ParsedItem): string {
  const t = humanise(item.text);
  if (!t) return '';
  if (item.id.startsWith('derived.')) return t;
  return `On ${item.label.toLowerCase()}: ${t}`;
}

/**
 * Context items are written for the model, not the reader.
 *
 * They are third-person, carry internal precision the reader does not need
 * ("94.2-100% through the chapter"), and sometimes contain directives aimed at
 * the model. A real provider rewrites all of that as a matter of course; the
 * mock has to do it explicitly to produce something a person would actually
 * want to read.
 */
function humanise(text: string): string {
  let t = text.replace(/\s+/g, ' ').trim();

  // Drop clauses that only ever addressed the model.
  t = t
    .split(/(?<=\.)\s+/)
    .filter((sentence) => !/^(Do not|Reasoning is anchored)/i.test(sentence.trim()))
    .join(' ');

  // Internal precision the reader does not need.
  t = t.replace(
    /This places the user roughly [\d.]+-[\d.]+% through the (\w+) chapter \((\w+) phase\)\./i,
    'You are in the $2 stretch of your $1 chapter.',
  );

  t = t
    .replace(/\bthe user's\b/gi, 'your')
    .replace(/\bthe user\b/gi, 'you')
    .replace(/\bIn this chart the\b/g, 'In your chart the')
    .replace(
      /\bso those areas are the ones this sub-period actually activates\b/g,
      'so those are the areas this sub-period actually stirs up',
    );

  return t.trim();
}

function trimToWords(text: string, maxWords: number): string {
  const words = text.split(/\s+/);
  if (words.length <= maxWords) return text;
  return (
    words
      .slice(0, maxWords)
      .join(' ')
      .replace(/[.,;:]$/, '') + '.'
  );
}
