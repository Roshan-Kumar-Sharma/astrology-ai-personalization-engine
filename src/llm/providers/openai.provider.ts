import { LlmProvider, LlmRequest, LlmResponse } from '../llm.provider';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  /** Reported as the provider name in logs and responses. */
  label?: string;
  /** Extra request headers, e.g. OpenRouter's attribution headers. */
  extraHeaders?: Record<string, string>;
}

/**
 * OpenAI-compatible provider.
 *
 * Implemented over plain HTTP rather than pulling in a second vendor SDK: the
 * chat-completions shape is stable and also accepted by Groq, Together,
 * OpenRouter and most self-hosted gateways, so one small adapter covers a lot
 * of ground. Its only job is to satisfy the same `LlmProvider` contract, which
 * is the point of having the contract.
 */
export class OpenAiLlmProvider implements LlmProvider {
  readonly name: string;
  readonly model: string;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.model = opts.model;
    this.name = opts.label ?? 'openai';
  }

  async generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    signal?.addEventListener('abort', () => controller.abort(), { once: true });

    try {
      const res = await fetch(`${this.opts.baseUrl}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.extraHeaders,
        },
        body: JSON.stringify({
          model: this.opts.model,
          max_tokens: req.maxTokens,
          messages: [
            { role: 'system', content: `${req.systemStatic}\n\n${req.systemDynamic}` },
            ...req.messages,
          ],
        }),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`${this.name} API error ${res.status}: ${body.slice(0, 300)}`);
      }

      const json = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string; reasoning?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        error?: { message?: string; code?: number };
      };

      // OpenRouter can return a 200 whose body carries a provider-side error
      // (free-model capacity, upstream refusal). Treat it as a failure so the
      // pipeline's fallback path engages instead of returning an empty answer.
      if (json.error) {
        throw new Error(`${this.name} upstream error: ${json.error.message ?? 'unknown'}`);
      }

      return {
        text: json.choices?.[0]?.message?.content ?? '',
        model: json.model ?? this.opts.model,
        provider: this.name,
        usage: {
          inputTokens: json.usage?.prompt_tokens,
          outputTokens: json.usage?.completion_tokens,
        },
        latencyMs: Math.round(performance.now() - started),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
