import { z } from 'zod';

/**
 * Environment schema. Validated once at boot so the process fails fast and loudly
 * rather than discovering a bad value on the first request.
 */
const EnvSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  // ---- Upstream services -------------------------------------------------
  // Point these at real services in production; the bundled mock server serves
  // them locally so the resilience code paths are exercised over real HTTP.
  UPSTREAM_USER_URL: z.string().default('http://127.0.0.1:4010'),
  UPSTREAM_KUNDLI_URL: z.string().default('http://127.0.0.1:4010'),
  UPSTREAM_HOROSCOPE_URL: z.string().default('http://127.0.0.1:4010'),
  UPSTREAM_PANCHANG_URL: z.string().default('http://127.0.0.1:4010'),

  /** Start the bundled mock upstream server in-process. */
  MOCK_UPSTREAM_ENABLED: z.coerce.boolean().default(true),
  MOCK_UPSTREAM_PORT: z.coerce.number().default(4010),
  /** Fault injection for demonstrating graceful degradation. 0.0 - 1.0 */
  MOCK_UPSTREAM_FAULT_RATE: z.coerce.number().min(0).max(1).default(0),
  /** Artificial latency floor in ms, to make concurrency visible in logs. */
  MOCK_UPSTREAM_LATENCY_MS: z.coerce.number().min(0).default(40),

  // ---- Resilience --------------------------------------------------------
  UPSTREAM_TIMEOUT_MS: z.coerce.number().default(1200),
  UPSTREAM_RETRY_ATTEMPTS: z.coerce.number().default(2),
  UPSTREAM_RETRY_BASE_DELAY_MS: z.coerce.number().default(60),
  /** Whole-request deadline for the fan-out stage. */
  CONTEXT_FANOUT_DEADLINE_MS: z.coerce.number().default(2500),

  // ---- LLM ---------------------------------------------------------------
  LLM_PROVIDER: z.enum(['mock', 'anthropic', 'openai', 'openrouter']).default('mock'),
  LLM_TIMEOUT_MS: z.coerce.number().default(20000),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-opus-5'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_MODEL: z.string().default('gpt-4o-mini'),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),

  /**
   * OpenRouter: one key, many models, with a genuine no-card free tier.
   * Its API is OpenAI-compatible, so it reuses the OpenAI adapter and differs
   * only in base URL and two attribution headers.
   */
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('minimax/minimax-m3:free'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  /** Sent as HTTP-Referer / X-Title; OpenRouter uses them for app attribution. */
  OPENROUTER_APP_URL: z.string().default('https://github.com/mynaksh/context-engine'),
  OPENROUTER_APP_NAME: z.string().default('MyNaksh Personalized AI Context Engine'),

  // ---- Context budget ----------------------------------------------------
  /** Hard ceiling on context tokens sent to the LLM (free tier). */
  CONTEXT_TOKEN_BUDGET_FREE: z.coerce.number().default(320),
  /** Premium users get a wider budget -> richer, more specific answers. */
  CONTEXT_TOKEN_BUDGET_PREMIUM: z.coerce.number().default(900),
});

export type AppConfig = z.infer<typeof EnvSchema>;

let cached: AppConfig | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}

export function appConfig(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

export const APP_CONFIG = Symbol('APP_CONFIG');
