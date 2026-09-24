// Sign-in attempt limits stored in PostgreSQL (spec §3.3; decision D-46): shared
// by every API instance, kept across restarts, keys stored only as hashes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Db } from '../src/lib/prisma.js';
import { createThrottle } from '../src/lib/throttle.js';
import { fastPasswords, makeUser, openDb, ORIGIN, PASSWORD, TEST_URL, testApp, testEnv, uniq } from './helpers.js';
import { createApp } from '../src/app.js';

const describeDb = TEST_URL ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeDb('sign-in throttle in the database (D-46)', () => {
  let db: Db;
  beforeAll(() => { db = openDb(); });
  afterAll(async () => { await db.$disconnect(); });

  it('blocks a key after `max` failures, and reset() frees it at once', async () => {
    const t = createThrottle(db, 900, 3, uniq('ns'));
    await t.fail('acct:a'); await t.fail('acct:a');
    expect(await t.blockedFor('acct:a')).toBe(0);
    await t.fail('acct:a');
    const wait = await t.blockedFor('acct:a');
    expect(wait).toBeGreaterThan(890);
    expect(wait).toBeLessThanOrEqual(900);
    expect(await t.blockedFor('acct:b')).toBe(0);
    await t.reset('acct:a');
    expect(await t.blockedFor('acct:a')).toBe(0);
  });

  it('a new window starts once the old one has ended', async () => {
    const t = createThrottle(db, 1, 2, uniq('ns'));
    await t.fail('k'); await t.fail('k');
    expect(await t.blockedFor('k')).toBeGreaterThan(0);
    await sleep(1100);
    expect(await t.blockedFor('k')).toBe(0);
    await t.fail('k'); // counts from 1 again
    expect(await t.blockedFor('k')).toBe(0);
  });

  it('two API instances share one count; concurrent failures are all counted', async () => {
    const ns = uniq('ns');
    const a = createThrottle(db, 900, 10, ns);
    const b = createThrottle(db, 900, 10, ns);
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).fail('ip:10.0.0.1')));
    expect(await a.blockedFor('ip:10.0.0.1')).toBeGreaterThan(0);
    expect(await b.blockedFor('ip:10.0.0.1')).toBeGreaterThan(0);
  });

  it('stores only a hash of the key — no e-mail address or client address', async () => {
    const email = `${uniq('who')}@test.aigh.sa`;
    const t = createThrottle(db, 900, 5, uniq('ns'));
    await t.fail(`acct:${email}`);
    const rows = await db.$queryRaw<Array<{ key_hash: string }>>`SELECT key_hash FROM login_throttle WHERE key_hash LIKE ${'%' + email + '%'}`;
    expect(rows).toHaveLength(0);
    expect(await db.loginThrottle.count({ where: { keyHash: { not: { contains: '@' } } } })).toBeGreaterThan(0);
  });

  it('sweeps expired rows', async () => {
    const t = createThrottle(db, 1, 5, uniq('ns'));
    await t.fail('old');
    await sleep(1100);
    await t.fail('new'); // the first failure after a window triggers the sweep
    expect(await db.loginThrottle.count({ where: { resetAt: { lte: new Date(Date.now() - 1000) } } })).toBe(0);
  });

  it('a restarted API still refuses a blocked account (the count outlives the process)', async () => {
    const env = testEnv({ LOGIN_THROTTLE_MAX_PER_ACCOUNT: '2' });
    const ns = uniq('app');
    const u = await makeUser(db);
    const before = createApp({ env, db, passwords: fastPasswords, throttleNamespace: ns });
    for (let i = 0; i < 2; i++) await request(before).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: 'wrong-password-123' });
    const after = createApp({ env, db, passwords: fastPasswords, throttleNamespace: ns }); // a new process
    const res = await request(after).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: PASSWORD });
    expect(res.status).toBe(429);
    // An app with its own namespace (another test) is unaffected.
    expect((await request(testApp(db)).post('/api/v1/auth/login').set('Origin', ORIGIN).send({ email: u.email, password: PASSWORD })).status).toBe(200);
  });
});
