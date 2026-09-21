import { loadConfig } from './app.config';

describe('config', () => {
  /**
   * Regression test for a live bug.
   *
   * These flags were `z.coerce.boolean()`, which applies JavaScript truthiness
   * to a string - so the string "false" parsed as `true` and every off switch
   * was welded on. `.env.example` documented "set MOCK_UPSTREAM_ENABLED=false to
   * take it out of the picture", and that did not work.
   */
  it.each([
    ['true', true],
    ['TRUE', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    ['false', false],
    ['FALSE', false],
    ['0', false],
    ['no', false],
    ['off', false],
    ['', false],
  ])('reads MOCK_UPSTREAM_ENABLED=%j as %s', (value, expected) => {
    expect(loadConfig({ MOCK_UPSTREAM_ENABLED: value } as never).MOCK_UPSTREAM_ENABLED).toBe(
      expected,
    );
  });

  it('defaults the intent fallback off', () => {
    const cfg = loadConfig({} as never);
    expect(cfg.INTENT_LLM_FALLBACK).toBe(false);
    expect(cfg.INTENT_LLM_THRESHOLD).toBe(0.35);
  });

  it('accepts the intent fallback being switched on', () => {
    expect(loadConfig({ INTENT_LLM_FALLBACK: 'true' } as never).INTENT_LLM_FALLBACK).toBe(true);
  });
});
