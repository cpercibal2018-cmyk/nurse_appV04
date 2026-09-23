// Worker leases (spec §10.3, V49): only one process runs a job at a time,
// whether jobs run inside the API process (development) or in a separate
// worker (production). A lease is a row in worker_leases taken only when free
// or expired; a heartbeat extends it while the job runs, so a crashed holder
// frees the job after `leaseSeconds`.

import { randomUUID } from 'node:crypto';
import type { Db } from './prisma.js';

export type LeaseOutcome<T> = { ran: true; result: T } | { ran: false };

export async function withLease<T>(db: Db, jobName: string, leaseSeconds: number, fn: () => Promise<T>): Promise<LeaseOutcome<T>> {
  const holderId = randomUUID();
  const taken = await db.$queryRaw<Array<{ holder_id: string }>>`
    INSERT INTO worker_leases (job_name, holder_id, acquired_at, heartbeat_at, expires_at, lease_seconds)
    VALUES (${jobName}, ${holderId}::uuid, now(), now(), now() + make_interval(secs => ${leaseSeconds}), ${leaseSeconds})
    ON CONFLICT (job_name) DO UPDATE
      SET holder_id = EXCLUDED.holder_id, acquired_at = now(), heartbeat_at = now(), expires_at = EXCLUDED.expires_at, lease_seconds = EXCLUDED.lease_seconds
      WHERE worker_leases.expires_at < now()
    RETURNING holder_id::text`;
  if (taken[0]?.holder_id !== holderId) return { ran: false };

  const beat = setInterval(() => {
    void db.$executeRaw`UPDATE worker_leases SET heartbeat_at = now(), expires_at = now() + make_interval(secs => ${leaseSeconds})
      WHERE job_name = ${jobName} AND holder_id = ${holderId}::uuid`.catch(() => undefined);
  }, Math.max(1000, (leaseSeconds * 1000) / 3));
  beat.unref();
  try {
    return { ran: true, result: await fn() };
  } finally {
    clearInterval(beat);
    await db.$executeRaw`DELETE FROM worker_leases WHERE job_name = ${jobName} AND holder_id = ${holderId}::uuid`;
  }
}
