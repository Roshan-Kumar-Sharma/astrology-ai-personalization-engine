import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Server } from 'node:http';
import request from 'supertest';
import { AppModule } from '../src/app.module';
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
      expect(res.body.sourcesUsed).toEqual(
        expect.arrayContaining(['Career Horoscope', '10th House', 'Current Dasha']),
      );
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
      expect(res.body.explain.tokenBudget.promptTokens.total).toBeGreaterThan(0);
      expect(res.body.explain.promptPreview).toContain('CONTEXT');
      expect(res.body.explain).not.toHaveProperty('answer');
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
