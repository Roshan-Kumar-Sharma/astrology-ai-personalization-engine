import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AppConfig } from '../../common/config/app.config';
import { StructuredLogger } from '../../common/logging/logger';
import { HOROSCOPES, KUNDLIS, panchangFor, transitsFor, USERS } from './fixtures';

/**
 * A stand-in for the MyNaksh backend services - the four in the brief plus a
 * transit (gochar) service - served over real HTTP on a separate port.
 *
 * Deliberately NOT an in-process stub. Running these over the loopback interface
 * means the concurrency, timeout, retry, abort and partial-failure code in the
 * aggregator is exercised for real rather than simulated - the same code path
 * runs whether UPSTREAM_*_URL points here or at production.
 *
 * Fault injection (MOCK_UPSTREAM_FAULT_RATE / MOCK_UPSTREAM_LATENCY_MS) exists so
 * graceful degradation can actually be demonstrated instead of asserted.
 */
export function startMockUpstream(cfg: AppConfig, logger: StructuredLogger): Promise<Server> {
  const server = createServer((req, res) => handle(req, res, cfg, logger));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.MOCK_UPSTREAM_PORT, '127.0.0.1', () => {
      logger.info('mock_upstream.started', {
        port: cfg.MOCK_UPSTREAM_PORT,
        faultRate: cfg.MOCK_UPSTREAM_FAULT_RATE,
        latencyMs: cfg.MOCK_UPSTREAM_LATENCY_MS,
      });
      resolve(server);
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AppConfig,
  logger: StructuredLogger,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${cfg.MOCK_UPSTREAM_PORT}`);
  const path = url.pathname;

  // Simulate network + service latency so parallel fan-out is visible in traces.
  const jitter = cfg.MOCK_UPSTREAM_LATENCY_MS * (0.5 + Math.random());
  await sleep(jitter);

  // Per-request fault injection. `?fail=1` forces a failure for scripted demos.
  const forced = url.searchParams.get('fail') === '1';
  if (forced || Math.random() < cfg.MOCK_UPSTREAM_FAULT_RATE) {
    logger.debug('mock_upstream.injected_fault', { path });
    return json(res, 503, { error: 'Service temporarily unavailable' });
  }

  const users = /^\/users\/([\w-]+)$/.exec(path);
  if (users) {
    const user = USERS[users[1]];
    return user ? json(res, 200, user) : json(res, 404, { error: 'user not found' });
  }

  const kundli = /^\/kundli\/([\w-]+)$/.exec(path);
  if (kundli) {
    const k = KUNDLIS[kundli[1]];
    return k ? json(res, 200, k) : json(res, 404, { error: 'kundli not found' });
  }

  const horoscope = /^\/horoscope\/([\w-]+)$/.exec(path);
  if (horoscope) {
    const h = HOROSCOPES[horoscope[1]];
    if (!h) return json(res, 404, { error: 'horoscope not found' });
    return json(res, 200, { ...h, date: url.searchParams.get('date') ?? today() });
  }

  if (path === '/panchang') {
    // Real panchang is sunrise-based and therefore location-specific. This
    // endpoint has no location parameter - a limitation we surface in the README.
    const date = url.searchParams.get('date') ?? today();
    return json(res, 200, panchangFor(date));
  }

  if (path === '/transits') {
    // Geocentric sidereal positions are the same everywhere on Earth, so unlike
    // the panchang this endpoint genuinely needs no location.
    const date = url.searchParams.get('date') ?? today();
    return json(res, 200, transitsFor(date));
  }

  if (path === '/health') return json(res, 200, { status: 'ok' });

  return json(res, 404, { error: 'not found' });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
