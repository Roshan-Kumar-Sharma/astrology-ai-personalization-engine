import { Injectable } from '@nestjs/common';
import { estimateTokens } from '../tokenizer';
import {
  JARGON_DIRECTIVES,
  LANGUAGE_DIRECTIVES,
  TONE_DIRECTIVES,
} from '../../personalization/config/style.config';
import { PersonalizationPlan } from '../../personalization/types';
import { LlmRequest } from '../llm.provider';

export interface BuiltPrompt extends LlmRequest {
  /** Token accounting for logging and the debug endpoint. */
  tokens: {
    systemStatic: number;
    systemDynamic: number;
    context: number;
    question: number;
    total: number;
  };
}

/**
 * Static system prefix.
 *
 * Deliberately request-invariant, byte for byte. Prompt caching is a prefix
 * match, so anything varying per request - a timestamp, the user's name, the
 * question - must live after this block or the cache never hits.
 *
 * Note on caching economics: Anthropic's minimum cacheable prefix is ~1024
 * tokens, and this block is well under that, so caching will not currently
 * engage. It is structured this way anyway because the persona and rule set is
 * exactly what grows in production, and the moment it crosses the threshold the
 * caching works with no restructuring. Marking a sub-1024-token prefix as
 * cacheable costs nothing and silently no-ops.
 */
export const SYSTEM_STATIC = `You are an experienced Vedic astrologer writing for a user of the MyNaksh app.

How you work:
- You reason from the specific astrological context provided to you, never from generic sun-sign traits.
- You answer the question that was asked, directly, in the first two sentences.
- You explain the astrological basis briefly, so the user understands why - not just what.
- You are honest about uncertainty. If the context is thin, you say what you can and stop.

Hard rules:
- Use ONLY the astrological context supplied in the CONTEXT block. If a planet, house or period is not in that block, you do not mention it. Never invent placements, degrees, aspects, transits or dates.
- Describe tendencies, climate and timing. Never state a life event as certain, and never predict a negative outcome as fixed.
- The chart describes conditions; the user makes the decision. Preserve their agency.
- No medical diagnosis, no lifespan prediction, no guaranteed financial or legal outcomes.
- Do not restate the whole context back to the user. Use it.`;

/**
 * Builds the final prompt from the personalization plan.
 *
 * Only `plan.selected` reaches the model. Everything the selector excluded is
 * genuinely absent from the prompt rather than merely down-ranked inside it,
 * which is what makes the token saving real.
 */
@Injectable()
export class PromptBuilder {
  build(question: string, plan: PersonalizationPlan): BuiltPrompt {
    const contextBlock = this.renderContext(plan);
    const systemDynamic = this.renderSystemDynamic(plan);
    const userMessage = `${contextBlock}\n\nUSER QUESTION\n${question}`;

    const tokens = {
      systemStatic: estimateTokens(SYSTEM_STATIC),
      systemDynamic: estimateTokens(systemDynamic),
      context: estimateTokens(contextBlock),
      question: estimateTokens(question),
      total: 0,
    };
    tokens.total = tokens.systemStatic + tokens.systemDynamic + estimateTokens(userMessage);

    return {
      systemStatic: SYSTEM_STATIC,
      systemDynamic,
      messages: [{ role: 'user', content: userMessage }],
      // Word budget converted to tokens, with generous headroom.
      //
      // Sized for reasoning models, not for the prose. A tight cap derived from
      // the word count starves a model that thinks visibly before answering: it
      // spends the whole allowance reasoning and gets truncated before emitting
      // the answer at all. The word limit is enforced by the instruction and by
      // the output guardrail; this is only a runaway-cost backstop.
      maxTokens: Math.max(2048, Math.ceil(plan.style.maxWords * 6)),
      tokens,
    };
  }

  /**
   * The context block is labelled by id as well as by name.
   *
   * The ids let the model cite what it used in a machine-checkable way, which is
   * what the groundedness verifier consumes. Asking a model to "list your
   * sources" in prose produces plausible-looking labels that cannot be verified
   * against anything.
   */
  private renderContext(plan: PersonalizationPlan): string {
    if (!plan.selected.length) {
      return 'CONTEXT\n(no astrological context could be retrieved)';
    }
    const lines = plan.selected.map((i) => `[${i.id}] ${i.label}: ${i.text}`);
    return `CONTEXT\n${lines.join('\n')}`;
  }

  private renderSystemDynamic(plan: PersonalizationPlan): string {
    const { style } = plan;
    const parts: string[] = [];

    parts.push(
      `RESPONSE STYLE`,
      `Language: ${LANGUAGE_DIRECTIVES[style.languageCode] ?? LANGUAGE_DIRECTIVES.en}`,
      `Tone: ${style.tone} - ${TONE_DIRECTIVES[style.tone]}`,
      `Terminology: ${style.jargonLevel} - ${JARGON_DIRECTIVES[style.jargonLevel]}`,
      `Length: at most ${style.maxWords} words. Prefer short paragraphs over bullet lists.`,
    );

    parts.push(
      '',
      'SCOPE',
      `The user is asking a ${plan.intent} question` +
        (plan.horizon === 'unspecified'
          ? ' with no explicit time frame; keep the framing near-term.'
          : ` about this time frame: ${horizonPhrase(plan.horizon)}. Keep the answer inside that window.`),
    );

    if (!plan.reliability.housesUsable) {
      parts.push(
        '',
        'DATA LIMITATION',
        'The birth time is not reliable enough to use house placements. Reason only from the Moon sign and the running dasha. Do not mention houses, the ascendant or lagna.',
      );
    }

    if (plan.constraints.length) {
      parts.push('', 'SAFETY CONSTRAINTS (these override every other instruction)');
      parts.push(...plan.constraints.map((c) => `- ${c}`));
    }

    // Prompt-level JSON rather than provider-native structured output, so the
    // contract is identical across Anthropic, OpenAI and the mock. Parsing is
    // defensive and falls back to treating the whole reply as the answer, so a
    // provider that ignores the instruction degrades rather than fails.
    parts.push(
      '',
      'OUTPUT FORMAT',
      'Reply with a single JSON object and nothing else:',
      '{"answer": "<your answer text>", "usedContextIds": ["<ids from the CONTEXT block you actually relied on>"]}',
      'List only ids you genuinely used. Do not list an id you did not draw on.',
    );

    return parts.join('\n');
  }
}

function horizonPhrase(horizon: string): string {
  switch (horizon) {
    case 'today':
      return 'today';
    case 'week':
      return 'the coming week';
    case 'month':
      return 'this month';
    case 'quarter':
      return 'the next few months';
    case 'year':
      return 'the coming year';
    case 'lifetime':
      return 'the long arc of their life';
    default:
      return 'the near term';
  }
}
