import { z } from 'zod';

/**
 * Environment schema. Validated once at boot so the process fails fast and loudly
 * rather than discovering a bad value on the first request.
 */
/**
 * Boolean env vars.
 *
 * `z.coerce.boolean()` is the wrong tool here and fails in the most dangerous
 * direction: it applies JavaScript truthiness to a string, so "false" and "0"
 * both parse as `true`. Every off switch written that way is welded on. This
 * reads the string the way an operator means it.
 */
const envBool = (def: boolean) =>
  z
    .union([z.boolean(), z.string()])
    .default(def)
    .transform((v) => (typeof v === 'boolean' ? v : /^(1|true|yes|on)$/i.test(v.trim())));

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
  UPSTREAM_TRANSIT_URL: z.string().default('http://127.0.0.1:4010'),

  /** Start the bundled mock upstream server in-process. */
  MOCK_UPSTREAM_ENABLED: envBool(true),
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
  OPENROUTER_MODEL: z.string().default('z-ai/glm-5.2:free'),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  /** Sent as HTTP-Referer / X-Title; OpenRouter uses them for app attribution. */
  OPENROUTER_APP_URL: z.string().default('https://github.com/mynaksh/context-engine'),
  OPENROUTER_APP_NAME: z.string().default('MyNaksh Personalized AI Context Engine'),

  // ---- Intent LLM fallback -----------------------------------------------
  /**
   * Escalate genuinely ambiguous questions to the LLM for classification.
   *
   * Off by default, and deliberately so: it adds a call to the critical path
   * for a decision the lexicon already gets right 86% of the time when it has
   * any evidence at all. Turn it on once the lift has been measured for your
   * traffic - `npm run eval:intent-llm` reports it.
   */
  INTENT_LLM_FALLBACK: envBool(false),
  /**
   * Escalate below this classifier confidence.
   *
   * 0.35 is the measured knee: it is exactly "the lexicon found no signal at
   * all" (those cases score 0.3), which on the golden set is 34% of questions
   * and contains 66% of all intent errors. Raising it to 0.60 buys 4 more
   * caught errors for 13 more points of traffic; anything above 0.87 escalates
   * almost everything, because that is where confident lexicon hits land.
   */
  INTENT_LLM_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  /**
   * Hard deadline for the classification call. Much tighter than the answer
   * timeout: this is one word of output on the critical path, and the lexicon
   * result is always available as a fallback, so waiting is never worth it.
   */
  INTENT_LLM_TIMEOUT_MS: z.coerce.number().default(4000),

  // ---- Second-layer safety screen ----------------------------------------
  /**
   * Ask the model to re-screen questions the deterministic layer allowed.
   *
   * Off by default. It screens every non-blocked question - there is no useful
   * confidence gate here, because the patterns are silent exactly where they
   * fail - so enabling it roughly doubles the LLM calls on safe traffic. The
   * case for paying that is in docs/11: the pattern layer scores 43.8% on
   * phrasings it was not tuned against.
   */
  SAFETY_LLM_SCREEN: envBool(false),
  /**
   * Tighter than the generation timeout. It runs concurrently with the upstream
   * fan-out, and the deterministic decision is already in hand, so waiting is
   * never worth more than a moment.
   */
  SAFETY_LLM_TIMEOUT_MS: z.coerce.number().default(4000),

  // ---- Debug surface -----------------------------------------------------
  /**
   * Serve `POST /debug/personalization` and the HTML console at `GET /console`.
   *
   * One switch for both, deliberately. The console renders nothing the debug
   * endpoint does not already return, so hiding the page while leaving the JSON
   * open would be security theatre. Neither carries authentication of its own:
   * in a real deployment they belong behind the same auth or network policy,
   * and this is the switch that takes the whole surface away.
   *
   * On by default because the debug endpoint is part of the assignment's
   * contract and the console is how you read it.
   */
  DEBUG_ENDPOINTS_ENABLED: envBool(true),

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
