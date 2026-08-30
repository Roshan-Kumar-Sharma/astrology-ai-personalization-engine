import Anthropic from '@anthropic-ai/sdk';
import { LlmProvider, LlmRequest, LlmResponse } from '../llm.provider';

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

/**
 * Anthropic Claude provider.
 *
 * Two deliberate choices worth noting:
 *
 * 1. The system prompt is sent as two blocks, with `cache_control` on the first.
 *    Prompt caching is a prefix match, so the invariant persona and rule set has
 *    to be a separate, byte-stable block ahead of anything per-request. Marking
 *    it costs nothing today (the block is under the ~1024-token minimum, so the
 *    cache silently no-ops) and starts paying the moment the persona grows.
 *
 * 2. No `temperature`. Sampling parameters are rejected with a 400 on Opus 5,
 *    Sonnet 5 and the 4.6+ family. Response variability is controlled through
 *    the effort setting instead.
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = 'anthropic';
  readonly model: string;
  private readonly client: Anthropic;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.model = opts.model;
    this.client = new Anthropic({ apiKey: opts.apiKey, timeout: opts.timeoutMs });
  }

  async generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const started = performance.now();
    try {
      const response = await this.client.messages.create(
        {
          model: this.model,
          max_tokens: req.maxTokens,
          system: [
            { type: 'text', text: req.systemStatic, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: req.systemDynamic },
          ],
          // A user-facing answer endpoint is latency-sensitive, and the hard
          // reasoning in this pipeline already happened deterministically
          // upstream. The model is composing prose from settled conclusions,
          // so low effort is the right trade rather than a cost compromise.
          output_config: { effort: 'low' },
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        },
        { signal },
      );

      const text = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return {
        text,
        model: response.model,
        provider: this.name,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          cacheReadTokens: response.usage.cache_read_input_tokens ?? undefined,
          cacheWriteTokens: response.usage.cache_creation_input_tokens ?? undefined,
        },
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      throw normaliseAnthropicError(err);
    }
  }

  /**
   * Exact token count for a prompt.
   *
   * Our own estimator is intentionally fast and approximate; this is the
   * ground truth to calibrate it against, and is worth running offline over a
   * sample of real prompts rather than on the request path.
   */
  async countTokens(req: LlmRequest): Promise<number> {
    const res = await this.client.messages.countTokens({
      model: this.model,
      system: [
        { type: 'text', text: req.systemStatic },
        { type: 'text', text: req.systemDynamic },
      ],
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    });
    return res.input_tokens;
  }
}

/**
 * Typed error classes, most specific first - a single broad catch would lose
 * the retryable/non-retryable distinction the caller needs.
 */
function normaliseAnthropicError(err: unknown): Error {
  if (err instanceof Anthropic.AuthenticationError) {
    return new Error('Anthropic authentication failed: check ANTHROPIC_API_KEY.');
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new Error('Anthropic rate limit reached.');
  }
  if (err instanceof Anthropic.BadRequestError) {
    return new Error(`Anthropic rejected the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new Error('Could not reach the Anthropic API.');
  }
  if (err instanceof Anthropic.APIError) {
    return new Error(`Anthropic API error ${err.status}: ${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
