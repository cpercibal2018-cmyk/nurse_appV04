// Fixed-window failure counter for sign-in attempts (spec §3.3 "account/client
// attempt limits"; decision D-46). Counters live in PostgreSQL, so every API
// instance shares them and a restart does not reset them. Each failure is one
// atomic upsert; the window runs on the database clock, so instances with
// drifting clocks still agree. Keys are stored as SHA-256 hashes.

import crypto from 'node:crypto';
import type { DbClient } from './prisma.js';

export function createThrottle(db: DbClient, windowSeconds: number, max: number, namespace = '') {
  const hash = (key: string) => crypto.createHash('sha256').update(namespace + key).digest('hex');
  // Expired rows are otherwise dropped only when their key fails again, so
  // unique keys (sprayed e-mails, one-off addresses) would accumulate. Each
  // process sweeps at most once per window.
  let nextSweepAt = 0;

  async function sweep() {
    const now = Date.now();
    if (now < nextSweepAt) return;
    nextSweepAt = now + windowSeconds * 1000;
    await db.$executeRaw`DELETE FROM login_throttle WHERE reset_at <= now()`;
  }

  return {
    /** Seconds until the key may try again, or 0 when it is not blocked. */
    async blockedFor(key: string): Promise<number> {
      const rows = await db.$queryRaw<Array<{ wait: number }>>`
        SELECT ceil(extract(epoch FROM reset_at - now()))::int AS wait
          FROM login_throttle WHERE key_hash = ${hash(key)} AND count >= ${max} AND reset_at > now()`;
      return rows[0]?.wait ?? 0;
    },
    /** Counts one failure; a key whose window has ended starts a new one. */
    async fail(key: string) {
      await db.$executeRaw`
        INSERT INTO login_throttle (key_hash, count, reset_at)
        VALUES (${hash(key)}, 1, now() + make_interval(secs => ${windowSeconds}))
        ON CONFLICT (key_hash) DO UPDATE SET
          count    = CASE WHEN login_throttle.reset_at <= now() THEN 1 ELSE login_throttle.count + 1 END,
          reset_at = CASE WHEN login_throttle.reset_at <= now() THEN EXCLUDED.reset_at ELSE login_throttle.reset_at END`;
      await sweep();
    },
    async reset(key: string) {
      await db.$executeRaw`DELETE FROM login_throttle WHERE key_hash = ${hash(key)}`;
    },
  };
}

export type Throttle = ReturnType<typeof createThrottle>;
