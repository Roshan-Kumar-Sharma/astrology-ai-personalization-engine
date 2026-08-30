import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { StructuredLogger } from './logger';

/**
 * Access log with request-id propagation.
 *
 * The id is echoed back on the response so a user-reported problem can be
 * traced to exactly one request across every log line the pipeline emitted.
 */
export function requestLogging(logger: StructuredLogger) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = (req.headers['x-request-id'] as string) || randomUUID();
    req.headers['x-request-id'] = requestId;
    res.setHeader('x-request-id', requestId);

    const started = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      logger.info('http.request', {
        requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(ms * 100) / 100,
      });
    });

    next();
  };
}
