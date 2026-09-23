// Phase 15 "no PII in logs": the one-line JSON logs carry identifiers only.
// Everything the server writes to the console while handling requests that
// carry an email, a password, names and a salary must contain none of them.

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Express } from 'express';
import { addDays, riyadhDate } from '../src/lib/dates.js';
import type { Db } from '../src/lib/prisma.js';
import { makeOrg, makeUser, openDb, ORIGIN, PASSWORD, signIn, TEST_URL, testApp } from './helpers.js';

const describeDb = TEST_URL ? describe : describe.skip;

describeDb('logs carry no personal data', () => {
  let db: Db;
  let app: Express;
  const lines: string[] = [];

  beforeAll(() => { db = openDb(); app = testApp(db); });
  afterAll(async () => { await db.$disconnect(); });
  afterEach(() => { vi.restoreAllMocks(); });

  const capture = () => {
    for (const m of ['log', 'warn', 'error', 'info'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    }
  };

  it('no email, password, name, salary or query text reaches the log', async () => {
    const org = await makeOrg(db);
    const user = await makeUser(db, { roles: [{ role: 'HR_ADMIN', scopeType: 'SYSTEM' }] });
    const hr = await signIn(app, user.email);
    capture();

    await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: user.email, password: 'Wrong-Secret-Password-9' });
    await request(app).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: 'nobody.unique@example.sa', password: PASSWORD });
    await signIn(app, user.email);
    await hr.post('/employees/onboard', {
      jobNumber: 'LOG-UNIQUE-77', firstName: 'Zainabunique', lastName: 'Qahtaniunique', contactEmail: 'zainab.unique@example.sa',
      salary: '98765.43', unitId: org.unitA.id, contractStart: riyadhDate(), contractEnd: addDays(riyadhDate(), 100),
    }).set('Idempotency-Key', randomUUID());
    await hr.get('/employees?q=Zainabunique');
    await hr.post('/employees/onboard', { firstName: 'Zainabunique', salary: 'not-a-number' }).set('Idempotency-Key', randomUUID());

    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(3);
    for (const secret of [user.email, 'nobody.unique@example.sa', 'Wrong-Secret-Password-9', PASSWORD, 'Zainabunique', 'Qahtaniunique', 'zainab.unique@example.sa', '98765.43', 'q=']) {
      expect(text, secret).not.toContain(secret);
    }
  });
});
