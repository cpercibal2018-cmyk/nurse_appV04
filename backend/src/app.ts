import cors from 'cors';
import express from 'express';
import type { Env } from './config/env.js';
import type { Db } from './lib/prisma.js';
import { errorHandler, unknownRoute } from './middleware/errors.js';
import { requestId } from './middleware/request-id.js';

export interface AppDeps {
  env: Env;
  db: Db;
}

const HEALTH_DB_TIMEOUT_MS = 2000;

/** Builds the Express application without starting a listener (tests use it directly). */
export function createApp({ env, db }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(requestId);
  // One exact origin; credentials allowed because the refresh token travels in a cookie.
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json({ limit: '1mb' }));

  // Liveness + database reachability. Deliberately reveals nothing else.
  app.get('/api/v1/health', async (_req, res) => {
    const database = await ping(db).then(() => 'up' as const, () => 'down' as const);
    res.status(database === 'up' ? 200 : 503).json({ status: database === 'up' ? 'ok' : 'degraded', database });
  });

  app.use('/api', unknownRoute);
  app.use(errorHandler);
  return app;
}

function ping(db: Db): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('database ping timed out')), HEALTH_DB_TIMEOUT_MS);
  });
  return Promise.race([db.$queryRaw`SELECT 1`, timeout]).finally(() => clearTimeout(timer));
}
