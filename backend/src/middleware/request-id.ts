import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from '../lib/logger.js';

declare global {
  namespace Express {
    interface Locals {
      requestId: string;
    }
  }
}

// A caller-supplied id is kept only if it is short and plain, so it cannot be
// used to inject content into logs or response headers.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Assigns X-Request-Id (reusing a safe incoming one) and writes one access-log line per request. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get('x-request-id');
  const id = incoming && SAFE_ID.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);

  const started = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('request', {
      requestId: id,
      method: req.method,
      // Path only: query strings can carry search terms with personal data.
      path: req.path,
      status: res.statusCode,
      ms: Number((process.hrtime.bigint() - started) / 1_000_000n),
    });
  });
  next();
};
