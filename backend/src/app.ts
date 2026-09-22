import express from 'express';
import type { Env } from './config/env.js';

/** Builds the Express application without starting a listener (tests use it directly). */
export function createApp(env: Env) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/v1/health', (_req, res) => {
    res.json({ status: 'ok', environment: env.NODE_ENV });
  });

  return app;
}
