/** Provider-agnostic LLM contract. */

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmRequest {
  /**
   * Static, request-invariant system text. Kept separate so providers that
   * support prompt caching can mark exactly this span as cacheable.
   */
  systemStatic: string;
  /** Per-request system text: style, safety constraints, output contract. */
  systemDynamic: string;
  messages: LlmMessage[];
  maxTokens: number;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface LlmResponse {
  text: string;
  model: string;
  provider: string;
  usage?: LlmUsage;
  latencyMs: number;
  /** True when the provider was unavailable and a degraded path was used. */
  degraded?: boolean;
}

/**
 * Injection token. Swapping providers is a container binding change, never an
 * edit to the pipeline - which is what "swappable LLM provider" has to mean if
 * it is going to survive contact with a second provider.
 */
export const LLM_PROVIDER = Symbol('LLM_PROVIDER');

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: LlmRequest, signal?: AbortSignal): Promise<LlmResponse>;
}
