import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';

describe('app skeleton', () => {
  it('answers the health check', async () => {
    const app = createApp(loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test' }));
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', environment: 'test' });
  });

  it('rejects an invalid environment at startup', () => {
    expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow(/Invalid environment/);
  });
});
