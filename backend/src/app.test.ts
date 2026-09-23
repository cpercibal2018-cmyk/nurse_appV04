import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import type { Db } from './lib/prisma.js';

const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test', JWT_SECRET: 'unit-test-secret-0123456789-abcdefghijkl' });
// Only $queryRaw is used by the health check; the rest of the client is not needed here.
const stubDb = (ping: () => Promise<unknown>) => ({ $queryRaw: ping }) as unknown as Db;
const app = createApp({ env, db: stubDb(async () => [{ '?column?': 1 }]) });

describe('health', () => {
  it('reports ok when the database answers', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', database: 'up' });
  });

  it('reports 503 when the database is down', async () => {
    const down = createApp({ env, db: stubDb(async () => { throw new Error('ECONNREFUSED'); }) });
    const res = await request(down).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ status: 'degraded', database: 'down' });
  });
});

describe('request id', () => {
  it('assigns one when the caller sends none', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('keeps a safe incoming id and replaces an unsafe one', async () => {
    const kept = await request(app).get('/api/v1/health').set('X-Request-Id', 'abc-123.x_y');
    expect(kept.headers['x-request-id']).toBe('abc-123.x_y');
    const replaced = await request(app).get('/api/v1/health').set('X-Request-Id', 'bad id <script>');
    expect(replaced.headers['x-request-id']).not.toContain('script');
  });
});

describe('error envelope', () => {
  it('answers an unknown path outside /api/v1 with 404 ROUTE_NOT_FOUND', async () => {
    const res = await request(app).get('/api/v2/nope');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'ROUTE_NOT_FOUND', message: 'No such endpoint' } });
  });

  it('answers any protected path with 401 for an anonymous caller (route existence is not revealed)', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('answers malformed JSON with 400 MALFORMED_BODY and no parser detail', async () => {
    const res = await request(app).post('/api/v1/nope').set('Content-Type', 'application/json').send('{"a":');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('MALFORMED_BODY');
    expect(JSON.stringify(res.body)).not.toMatch(/Unexpected|JSON\.parse|position/);
  });

  it('answers an oversized body with 413', async () => {
    const res = await request(app).post('/api/v1/nope').set('Content-Type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('CORS', () => {
  it('allows the configured origin with credentials', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'http://localhost:5173');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not allow any other origin', async () => {
    const res = await request(app).get('/api/v1/health').set('Origin', 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).not.toBe('https://evil.example');
  });
});

describe('environment', () => {
  it('rejects an invalid environment at startup', () => {
    expect(() => loadEnv({ PORT: 'not-a-number' })).toThrow(/Invalid environment/);
  });

  it('parses the residency allowlist into trimmed entries', () => {
    const e = loadEnv({ DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'unit-test-secret-0123456789-abcdefghijkl', PDPL_ALLOWED_REGIONS: ' me-riyadh-1 , ksa-onprem ,' });
    expect(e.PDPL_ALLOWED_REGIONS).toEqual(['me-riyadh-1', 'ksa-onprem']);
  });
});

describe('JWT secret', () => {
  it('is required and must be at least 32 characters', () => {
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://x/y' })).toThrow(/JWT_SECRET/);
    expect(() => loadEnv({ DATABASE_URL: 'postgresql://x/y', JWT_SECRET: 'too-short' })).toThrow(/JWT_SECRET/);
  });
});
