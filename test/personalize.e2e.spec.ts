import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { CONSOLE_PRESETS } from '../src/api/console.presets';
import { USERS } from '../src/upstream/mock/fixtures';
import { APP_CONFIG, loadConfig } from '../src/common/config/app.config';
import { StructuredLogger } from '../src/common/logging/logger';
import { startMockUpstream } from '../src/upstream/mock/mock-upstream.server';

/**
 * End-to-end over real HTTP, including the mock upstream on its own port.
 *
 * Deliberately not stubbed at the service boundary: the concurrency, retry,
 * timeout and partial-failure paths only mean something if a socket is actually
 * involved.
 */
const PORT = 4099;

const TEST_ENV = {
  ...process.env,
  MOCK_UPSTREAM_ENABLED: 'false', // started manually below
  MOCK_UPSTREAM_PORT: String(PORT),
  MOCK_UPSTREAM_LATENCY_MS: '1',
  MOCK_UPSTREAM_FAULT_RATE: '0',
  UPSTREAM_USER_URL: `http://127.0.0.1:${PORT}`,
  UPSTREAM_KUNDLI_URL: `http://127.0.0.1:${PORT}`,
  UPSTREAM_HOROSCOPE_URL: `http://127.0.0.1:${PORT}`,
  UPSTREAM_PANCHANG_URL: `http://127.0.0.1:${PORT}`,
  UPSTREAM_TRANSIT_URL: `http://127.0.0.1:${PORT}`,
  LLM_PROVIDER: 'mock',
  LOG_LEVEL: 'error',
};

describe('Personalized AI Context Engine (e2e)', () => {
  let app: INestApplication;
  let upstream: Server;

  beforeAll(async () => {
    const cfg = loadConfig({ ...TEST_ENV, MOCK_UPSTREAM_ENABLED: 'true' });
    const logger = new StructuredLogger();
    logger.setLevel('error');
    upstream = await startMockUpstream(cfg, logger);

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(APP_CONFIG)
      .useValue(loadConfig(TEST_ENV))
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    // fetch keep-alive holds sockets open; without this jest hangs on exit.
    upstream.closeAllConnections?.();
    await new Promise<void>((r) => upstream.close(() => r()));
  });

  const post = (body: Record<string, unknown>, path = '/personalize') =>
    request(app.getHttpServer()).post(path).send(body);

  describe('POST /personalize', () => {
    it("answers the brief's example request with the documented contract", async () => {
      const res = await post({
        userId: 'user_101',
        question: 'Should I consider changing my job in the next few months?',
      }).expect(200);

      expect(Object.keys(res.body).sort()).toEqual(['answer', 'confidence', 'sourcesUsed']);
      expect(typeof res.body.answer).toBe('string');
      expect(res.body.answer.length).toBeGreaterThan(50);
      expect(['HIGH', 'MEDIUM', 'LOW']).toContain(res.body.confidence);
      // The mock provider cites the first four items of the prompt, and at a
      // "next few months" horizon several primaries tie and are ordered by
      // token cost - so which dasha item makes the cut is a tie-break, not a
      // contract. What is contractual: the career sources lead, and the answer
      // rests on the running dasha in some form.
      expect(res.body.sourcesUsed).toEqual(
        expect.arrayContaining(['Career Horoscope', '10th House']),
      );
      expect(res.body.sourcesUsed.some((s: string) => /Dasha/.test(s))).toBe(true);
    });

    it('does not leak relationship context into a career answer', async () => {
      const res = await post({
        userId: 'user_101',
        question: 'Should I consider changing my job in the next few months?',
      }).expect(200);
      expect(res.body.sourcesUsed).not.toContain('Relationship Horoscope');
      expect(res.body.sourcesUsed).not.toContain('7th House');
    });

    it('handles every sample question in the brief', async () => {
      const questions = [
        'Should I consider changing my job this year?',
        'How does this month look for my relationship?',
        'What should I focus on for my health?',
        'What should I prioritize this week?',
        "Can you summarize today's guidance?",
      ];
      for (const question of questions) {
        const res = await post({ userId: 'user_101', question }).expect(200);
        expect(res.body.answer).toBeTruthy();
        expect(res.body.sourcesUsed.length).toBeGreaterThan(0);
      }
    });

    it('returns the engine trace when verbose is requested', async () => {
      const res = await post({
        userId: 'user_101',
        question: 'Should I consider changing my job in the next few months?',
        verbose: true,
      }).expect(200);

      expect(res.body.meta.intent).toBe('career');
      expect(res.body.meta.horizon).toBe('quarter');
      expect(res.body.meta.confidence.factors.length).toBeGreaterThan(0);
      expect(res.body.meta.tokens.contextSelected).toBeGreaterThan(0);
      expect(res.body.meta.latency.spans.length).toBeGreaterThan(0);
    });

    describe('safety', () => {
      it('blocks a death-timing question without calling the LLM', async () => {
        const res = await post({
          userId: 'user_101',
          question: 'When will I die?',
          verbose: true,
        }).expect(200);
        expect(res.body.meta.blocked).toBe(true);
        expect(res.body.sourcesUsed).toEqual([]);
        expect(res.body.answer).toMatch(/don't make predictions about death/i);
      });

      it('returns crisis resources for a self-harm question', async () => {
        const res = await post({
          userId: 'user_101',
          question: "I don't want to live anymore",
        }).expect(200);
        expect(res.body.answer).toContain('14416');
      });

      it('answers a normal health question normally', async () => {
        const res = await post({
          userId: 'user_101',
          question: 'What should I focus on for my health?',
        }).expect(200);
        expect(res.body.sourcesUsed.length).toBeGreaterThan(0);
      });
    });

    describe('personalization by user', () => {
      it('reflects each profile in language, tone and length', async () => {
        const en = await post({ userId: 'user_101', question: 'How is my week?', verbose: true });
        const hi = await post({ userId: 'user_102', question: 'How is my week?', verbose: true });
        expect(en.body.meta.style.language).toBe('English');
        expect(en.body.meta.style.tone).toBe('motivational');
        expect(hi.body.meta.style.language).toBe('Hindi');
        expect(hi.body.meta.style.tone).toBe('gentle');
        // Premium buys a longer answer and a wider context budget.
        expect(en.body.meta.style.maxWords).toBeGreaterThan(hi.body.meta.style.maxWords);
        expect(en.body.meta.tokens.contextBudget).toBeGreaterThan(
          hi.body.meta.tokens.contextBudget,
        );
      });

      it('drops to MEDIUM and suppresses houses when the birth time is unknown', async () => {
        const res = await post({
          userId: 'user_103',
          question: 'What should I focus on for my health?',
          verbose: true,
        }).expect(200);
        expect(res.body.confidence).not.toBe('HIGH');
        expect(res.body.sourcesUsed.join(' ')).not.toMatch(/House|Lagna|Ascendant/);
      });
    });

    describe('validation', () => {
      it('rejects a missing question', () => post({ userId: 'user_101' }).expect(400));
      it('rejects an empty question', () => post({ userId: 'user_101', question: '' }).expect(400));
      it('rejects an over-long question', () =>
        post({ userId: 'user_101', question: 'x'.repeat(1001) }).expect(400));
      it('rejects an unexpected field', () =>
        post({ userId: 'user_101', question: 'How is my week?', evil: 1 }).expect(400));
    });

    /** A user with no upstream data must still get an answer, at low confidence. */
    it('degrades rather than failing when the user does not exist', async () => {
      const res = await post({
        userId: 'nobody_999',
        question: 'Should I change my job?',
      }).expect(200);
      expect(res.body.answer).toBeTruthy();
      expect(res.body.confidence).toBe('LOW');
    });
  });

  describe('POST /debug/personalization', () => {
    const debug = (body: Record<string, unknown>) => post(body, '/debug/personalization');

    it('returns the documented debug shape', async () => {
      const res = await debug({
        userId: 'user_101',
        question: 'Should I consider changing my job in the next few months?',
      }).expect(200);

      expect(res.body.intent).toBe('career');
      expect(res.body.language).toBe('English');
      expect(res.body.tone).toBe('Motivational');
      expect(res.body.selectedContext).toEqual(
        expect.arrayContaining(['Career Horoscope', '10th House']),
      );
      expect(res.body.excludedContext).toEqual(expect.arrayContaining(['Relationship Horoscope']));
    });

    it('never lists a label as both selected and excluded', async () => {
      const res = await debug({
        userId: 'user_101',
        question: 'Should I consider changing my job in the next few months?',
      }).expect(200);
      const overlap = res.body.selectedContext.filter((s: string) =>
        res.body.excludedContext.includes(s),
      );
      expect(overlap).toEqual([]);
    });

    it('explains why each item was excluded', async () => {
      const res = await debug({
        userId: 'user_101',
        question: 'Should I consider changing my job in the next few months?',
      }).expect(200);
      for (const e of res.body.explain.excluded) {
        expect(e.reason).toBeTruthy();
        expect(e.detail).toBeTruthy();
      }
    });

    describe('transits (gochar)', () => {
      it('reads Sade Sati from the Moon sign even when the birth time is unknown', async () => {
        const res = await debug({ userId: 'user_103', question: 'Is my Sade Sati over?' }).expect(
          200,
        );
        const ids = res.body.explain.selected.map((i: { id: string }) => i.id);
        expect(ids).toContain('derived.transit.sade_sati');
        // Nothing house-relative was built for this chart at all.
        expect(ids.some((id: string) => /transit\.\w+\.house\./.test(id))).toBe(false);
        const fact = res.body.explain.selected.find(
          (i: { id: string }) => i.id === 'derived.transit.sade_sati',
        );
        expect(fact.text).toMatch(/Sade Sati, setting/);
        expect(fact.text).toMatch(/a climate, not a verdict/);
      });

      it('promotes the facts about a planet the question names', async () => {
        const plain = await debug({ userId: 'user_102', question: 'How are things?' });
        const named = await debug({ userId: 'user_102', question: 'Is Sade Sati affecting me?' });
        expect(named.body.explain.focus).toEqual(['Saturn']);
        const score = (r: typeof plain, id: string) =>
          r.body.explain.selected.find((i: { id: string }) => i.id === id)?.score ?? 0;
        expect(score(named, 'derived.transit.saturn')).toBeGreaterThan(
          score(plain, 'derived.transit.saturn'),
        );
      });

      it('moves the transits the opposite way to the panchang as the horizon widens', async () => {
        const today = await debug({ userId: 'user_101', question: 'How is my job today?' });
        const year = await debug({ userId: 'user_101', question: 'How is my job this year?' });
        const has = (r: typeof today, id: string) =>
          r.body.explain.selected.some((i: { id: string }) => i.id === id);
        expect(has(today, 'panchang.tithi')).toBe(true);
        expect(has(today, 'derived.transit.saturn')).toBe(false);
        expect(has(year, 'panchang.tithi')).toBe(false);
        expect(has(year, 'derived.transit.saturn')).toBe(true);
      });
    });

    it('shows the time horizon changing what is selected', async () => {
      const today = await debug({ userId: 'user_101', question: 'How is my job today?' });
      const quarter = await debug({
        userId: 'user_101',
        question: 'How is my job over the next few months?',
      });

      expect(today.body.explain.timeHorizon.horizon).toBe('today');
      expect(quarter.body.explain.timeHorizon.horizon).toBe('quarter');

      const panchangToday = today.body.selectedContext.some((s: string) => /Panchang/.test(s));
      const panchangQuarter = quarter.body.selectedContext.some((s: string) => /Panchang/.test(s));
      expect(panchangToday).toBe(true);
      expect(panchangQuarter).toBe(false);
    });

    it('reports upstream health and prompt size without generating', async () => {
      const res = await debug({ userId: 'user_101', question: 'How is my week?' }).expect(200);
      expect(res.body.explain.upstream.kundli.outcome).toMatch(/ok|cached/);
      expect(res.body.explain.upstream.transit.outcome).toMatch(/ok|cached/);
      expect(res.body.explain.tokenBudget.promptTokens.total).toBeGreaterThan(0);
      expect(res.body.explain.promptPreview).toContain('CONTEXT');
      expect(res.body.explain).not.toHaveProperty('answer');
    });
  });

  /**
   * The console is a viewer over `/debug/personalization`, so it needs almost no
   * tests of its own. The exception is the preset list: those chips each make a
   * claim about the engine in prose, and prose does not fail a build. Asserting
   * the claims is what keeps the demo honest as the rules change.
   */
  describe('the debug console', () => {
    it('serves a self-contained page', async () => {
      const res = await request(app.getHttpServer()).get('/console').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/html/);
      expect(res.text).toContain('debug console');
      // No CDN, no build step, nothing fetched from the network: the page has to
      // work offline and in a locked-down container.
      expect(res.text).not.toMatch(/<script[^>]+src=/);
      expect(res.text).not.toMatch(/<link[^>]+stylesheet/);
    });

    it('describes the running service rather than the one it was written against', async () => {
      const res = await request(app.getHttpServer()).get('/console/bootstrap').expect(200);
      expect(res.body.users.map((u: { id: string }) => u.id)).toContain('user_103');
      expect(res.body.llm.provider).toBe('mock');
      expect(res.body.flags).toHaveProperty('SAFETY_LLM_SCREEN');
      expect(res.body.presets.length).toBe(CONSOLE_PRESETS.length);
    });

    it('only offers presets for users the fixtures actually have', () => {
      for (const preset of CONSOLE_PRESETS) {
        expect(Object.keys(USERS)).toContain(preset.userId);
      }
    });

    describe('every preset still demonstrates what it claims', () => {
      for (const preset of CONSOLE_PRESETS) {
        it(preset.label, async () => {
          const res = await post(
            { userId: preset.userId, question: preset.question },
            '/debug/personalization',
          ).expect(200);
          const e = res.body.explain;
          const claim = preset.expect;
          const selected: string = res.body.selectedContext.join(' ');

          if (claim.intent) expect(e.intentDetection.intent).toBe(claim.intent);
          if (claim.horizon) expect(e.timeHorizon.horizon).toBe(claim.horizon);
          if (claim.blocked !== undefined) expect(e.safety.blocked).toBe(claim.blocked);
          if (claim.policy) expect(e.safety.policies).toContain(claim.policy);
          if (claim.language) expect(res.body.language).toBe(claim.language);
          if (claim.housesUsed !== undefined) {
            expect(/House|Lagna|Ascendant/.test(selected)).toBe(claim.housesUsed);
          }
          if (claim.panchangUsed !== undefined) {
            expect(/Panchang|Tithi|Nakshatra|Yoga|Karana/.test(selected)).toBe(claim.panchangUsed);
          }
          if (claim.selects) {
            const ids = e.selected.map((i: { id: string }) => i.id);
            for (const id of claim.selects) expect(ids).toContain(id);
          }
        });
      }
    });
  });

  describe('with the transit service unreachable', () => {
    let noTransit: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(APP_CONFIG)
        // Port 1 is reserved and never listening: an immediate connection refusal.
        .useValue(loadConfig({ ...TEST_ENV, UPSTREAM_TRANSIT_URL: 'http://127.0.0.1:1' }))
        .compile();
      noTransit = moduleRef.createNestApplication();
      await noTransit.init();
    }, 20_000);

    afterAll(async () => {
      await noTransit?.close();
    });

    it('still answers, says which source is missing, and sends no transit facts', async () => {
      const res = await request(noTransit.getHttpServer())
        .post('/debug/personalization')
        .send({ userId: 'user_101', question: 'Should I change my job this year?' })
        .expect(200);
      expect(res.body.explain.upstream.transit.outcome).toBe('failed');
      const ids = res.body.explain.selected.map((i: { id: string }) => i.id);
      // Not `includes('transit')`: "derived.dasha.transition" would match.
      expect(ids.some((id: string) => /^(derived\.)?transit\./.test(id))).toBe(false);
      // The natal chart and the dasha still carry the answer.
      expect(ids).toContain('derived.house.10');
      expect(ids).toContain('derived.dasha.position');
      const completeness = res.body.explain.projectedConfidence.factors.find(
        (f: { name: string }) => f.name === 'dataCompleteness',
      );
      expect(completeness.note).toContain('transit:failed');
      expect(completeness.value).toBe(0.9);
    });
  });

  describe('with DEBUG_ENDPOINTS_ENABLED=false', () => {
    let offApp: INestApplication;

    beforeAll(async () => {
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(APP_CONFIG)
        .useValue(loadConfig({ ...TEST_ENV, DEBUG_ENDPOINTS_ENABLED: 'false' }))
        .compile();
      offApp = moduleRef.createNestApplication();
      await offApp.init();
    }, 20_000);

    afterAll(async () => {
      await offApp?.close();
    });

    it('takes the whole debug surface away, not just the page', async () => {
      await request(offApp.getHttpServer()).get('/console').expect(404);
      await request(offApp.getHttpServer()).get('/console/bootstrap').expect(404);
      // The point of the flag: hiding the UI while leaving the JSON endpoint
      // open would expose exactly the same data to anyone who reads the README.
      await request(offApp.getHttpServer())
        .post('/debug/personalization')
        .send({ userId: 'user_101', question: 'How is my week?' })
        .expect(404);
    });

    it('leaves the product endpoint alone', async () => {
      await request(offApp.getHttpServer())
        .post('/personalize')
        .send({ userId: 'user_101', question: 'How is my week?' })
        .expect(200);
    });
  });

  describe('GET /health', () => {
    it('reports status and cache statistics', async () => {
      const res = await request(app.getHttpServer()).get('/health').expect(200);
      expect(res.body.status).toBe('ok');
      expect(res.body.cache).toHaveProperty('hits');
    });
  });
});
