import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Controller,
  Get,
  Header,
  Inject,
  InternalServerErrorException,
  UseGuards,
} from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../common/config/app.config';
import { USERS } from '../upstream/mock/fixtures';
import { CONSOLE_PRESETS } from './console.presets';
import { DebugEnabledGuard } from './debug-enabled.guard';

const PAGE = join(__dirname, 'console.html');

/**
 * The debug console.
 *
 * `POST /debug/personalization` already returns every decision the engine made;
 * what it does not do is make those decisions *legible* at a glance. Four
 * hundred lines of JSON are a poor way to see that the panchang disappeared
 * when the horizon moved, or that a house-based item was suppressed because a
 * birth time was rounded to the half hour.
 *
 * So this serves one static page that drives the existing endpoint. It is
 * deliberately a *viewer*, not a second implementation: it adds no engine logic,
 * computes nothing the payload does not contain, and exposes nothing the API
 * does not already expose. When the engine changes, the console changes with it
 * for free - and when the two disagree, the console is wrong by definition.
 *
 * No build step, no framework, no CDN. One HTML file with inline CSS and
 * vanilla JS, which means it works offline, in a container, and in a locked-down
 * network - and that the repository gains no frontend dependency for it.
 */
@Controller('console')
@UseGuards(DebugEnabledGuard)
export class ConsoleController {
  /** Read once in production; re-read per request in dev so edits show on reload. */
  private cached?: string;

  constructor(@Inject(APP_CONFIG) private readonly cfg: AppConfig) {}

  @Get()
  @Header('Content-Type', 'text/html; charset=utf-8')
  // The page is a static asset that changes only on deploy, but it is also the
  // thing you reload constantly while debugging. Revalidate rather than cache.
  @Header('Cache-Control', 'no-cache')
  page(): string {
    if (this.cfg.NODE_ENV === 'production' && this.cached) return this.cached;

    try {
      const html = readFileSync(PAGE, 'utf8');
      this.cached = html;
      return html;
    } catch (err) {
      // Almost always one thing: a compiled build where the HTML was not copied
      // next to the JS. Say so, rather than surfacing a bare ENOENT.
      throw new InternalServerErrorException(
        `Console page not found at ${PAGE}. If this is a compiled build, check the "assets" ` +
          `entry in nest-cli.json copies src/api/*.html into dist. (${
            err instanceof Error ? err.message : String(err)
          })`,
      );
    }
  }

  /**
   * Everything the page needs to describe the *running* service, rather than
   * the service it was written against.
   *
   * The provider block matters more than it looks. Every resilience path in
   * this codebase turns a broken dependency into something that looks healthy -
   * a dead model silently becomes the mock provider and still returns fluent,
   * chart-shaped prose. Showing the configured provider in the header means a
   * reader cannot mistake one for the other by looking at the text.
   */
  @Get('bootstrap')
  bootstrap() {
    return {
      // The bundled fixture ids, as *suggestions* for the picker - any id can be
      // typed. They are always offered, and the page labels them honestly:
      // `mockUpstream` says whether this process is serving them itself, which
      // is not the same question as whether the upstreams are fixtures (the e2e
      // suite runs the same fixtures from a separate port with the flag off).
      // Getting that wrong the first time made this list silently empty in
      // tests, which is how the distinction got noticed at all.
      users: Object.values(USERS).map((u) => ({
        id: u.id,
        name: u.name,
        language: u.language,
        subscription: u.subscription,
        tone: u.tonePreference,
        birthTime: u.birthDetails.timeAccuracy,
      })),
      mockUpstream: this.cfg.MOCK_UPSTREAM_ENABLED,
      presets: CONSOLE_PRESETS.map((p) => ({
        label: p.label,
        userId: p.userId,
        question: p.question,
        demonstrates: p.demonstrates,
      })),
      llm: { provider: this.cfg.LLM_PROVIDER, model: this.model() },
      flags: {
        INTENT_LLM_FALLBACK: this.cfg.INTENT_LLM_FALLBACK,
        INTENT_LLM_THRESHOLD: this.cfg.INTENT_LLM_THRESHOLD,
        SAFETY_LLM_SCREEN: this.cfg.SAFETY_LLM_SCREEN,
      },
      budgets: {
        free: this.cfg.CONTEXT_TOKEN_BUDGET_FREE,
        premium: this.cfg.CONTEXT_TOKEN_BUDGET_PREMIUM,
      },
    };
  }

  private model(): string {
    switch (this.cfg.LLM_PROVIDER) {
      case 'anthropic':
        return this.cfg.ANTHROPIC_MODEL;
      case 'openai':
        return this.cfg.OPENAI_MODEL;
      case 'openrouter':
        return this.cfg.OPENROUTER_MODEL;
      default:
        return 'deterministic local provider';
    }
  }
}
