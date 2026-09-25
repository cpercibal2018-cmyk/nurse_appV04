// Job scheduler. Runs inside the API process in development and in the
// separate worker (jobs/worker.ts) in production (plan §2 "Jobs"; spec §10.2).
//
// Every minute it asks each job whether its current period is due. A period
// is a run key (e.g. `daily-transition:2026-09-23`) claimed through job_runs:
// a completed key never runs again, a failed or stuck one is retried (at most
// MAX_ATTEMPTS), and a missed day is simply run when the process is next up
// (N4). The worker lease keeps two processes from running one job at once.
//
// Times are Asia/Riyadh (spec §7.1 names 06:00 Riyadh = 03:00 UTC):
//   daily-transition  00:05 daily  — date-driven state (§6.1 "midnight")
//   expiry-scan       06:00 daily  — reminders (§7.1)
//   attendance-alerts every 15 min — coverage gaps (§14.2)
//   consistency-audit 03:00 daily  — eligibility anti-drift sample (§10.8)
//   mock-sms-purge    02:40 daily  — intercepted texts older than 30 days (D-59)
//   scfhs-sync        05:00 daily  — licences checked with SCFHS (§5.4, D-64)

import type { Db } from '../lib/prisma.js';
import { riyadhDate } from '../lib/dates.js';
import { describeError, logger } from '../lib/logger.js';
import { withLease } from '../lib/worker-lease.js';
import { attendanceAlerts } from './attendance-alerts.js';
import { consistencyAudit } from './consistency-audit.js';
import { mockSmsPurge } from './mock-sms-purge.js';
import { scfhsSync } from './scfhs-sync.js';
import { requestLogPurge } from './request-log-purge.js';
import { vaultReconcile } from './vault-reconcile.js';
import { dailyTransition } from './daily-transition.js';
import { expiryScan } from './expiry-scan.js';

export const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 300;

/** HH:MM in Riyadh (UTC+3, no daylight saving). */
const riyadhTime = (now: Date) => new Date(now.getTime() + 3 * 3600_000).toISOString().slice(11, 16);

export interface JobDefinition {
  name: string;
  schedule: string;
  /** The run key for `now`, or null when nothing is due yet. */
  periodKey: (now: Date) => string | null;
  run: (db: Db, now: Date) => Promise<Record<string, unknown>>;
  /** A completed run older than this means the job is not running (business health, §10.8). */
  maxAgeMinutes: number;
}

const dailyAt = (name: string, hhmm: string) => (now: Date) => (riyadhTime(now) >= hhmm ? `${name}:${riyadhDate(now)}` : null);

export const JOBS: JobDefinition[] = [
  { name: 'daily-transition', schedule: 'daily 00:05 Asia/Riyadh', periodKey: dailyAt('daily-transition', '00:05'), run: dailyTransition, maxAgeMinutes: 26 * 60 },
  { name: 'expiry-scan', schedule: 'daily 06:00 Asia/Riyadh', periodKey: dailyAt('expiry-scan', '06:00'), run: expiryScan, maxAgeMinutes: 26 * 60 },
  {
    name: 'attendance-alerts', schedule: 'every 15 minutes',
    periodKey: (now) => { const [h, m] = riyadhTime(now).split(':').map(Number); return `attendance-alerts:${riyadhDate(now)}T${String(h).padStart(2, '0')}:${String(Math.floor(m! / 15) * 15).padStart(2, '0')}`; },
    run: attendanceAlerts, maxAgeMinutes: 60,
  },
  { name: 'consistency-audit', schedule: 'daily 03:00 Asia/Riyadh', periodKey: dailyAt('consistency-audit', '03:00'), run: consistencyAudit, maxAgeMinutes: 26 * 60 },
  { name: 'request-log-purge', schedule: 'daily 02:30 Asia/Riyadh', periodKey: dailyAt('request-log-purge', '02:30'), run: requestLogPurge, maxAgeMinutes: 26 * 60 },
  { name: 'mock-sms-purge', schedule: 'daily 02:40 Asia/Riyadh', periodKey: dailyAt('mock-sms-purge', '02:40'), run: mockSmsPurge, maxAgeMinutes: 26 * 60 },
  { name: 'scfhs-sync', schedule: 'daily 05:00 Asia/Riyadh', periodKey: dailyAt('scfhs-sync', '05:00'), run: scfhsSync, maxAgeMinutes: 26 * 60 },
  { name: 'vault-reconcile', schedule: 'daily 04:30 Asia/Riyadh', periodKey: dailyAt('vault-reconcile', '04:30'), run: vaultReconcile, maxAgeMinutes: 26 * 60 },
];

export type RunOutcome = { job: string; runKey: string; status: 'COMPLETED' | 'FAILED' | 'SKIPPED'; summary?: Record<string, unknown>; error?: string };

/** Claims a run key: new, or a failed/stuck earlier attempt. Returns false when another run owns or finished it. */
async function claim(db: Db, job: string, runKey: string, now: Date): Promise<boolean> {
  const existing = await db.jobRun.findUnique({ where: { runKey } });
  if (!existing) {
    try { await db.jobRun.create({ data: { jobName: job, runKey } }); return true; } catch { return false; }
  }
  if (existing.status === 'COMPLETED' || existing.attempts >= MAX_ATTEMPTS) return false;
  const stale = existing.status === 'RUNNING' && existing.startedAt.getTime() < now.getTime() - LEASE_SECONDS * 1000;
  if (existing.status === 'RUNNING' && !stale) return false;
  const taken = await db.jobRun.updateMany({
    where: { id: existing.id, status: existing.status, attempts: existing.attempts },
    data: { status: 'RUNNING', startedAt: now, finishedAt: null, error: null, attempts: { increment: 1 } },
  });
  return taken.count === 1;
}

export async function runJob(db: Db, job: JobDefinition, runKey: string, now = new Date()): Promise<RunOutcome> {
  if (!(await claim(db, job.name, runKey, now))) return { job: job.name, runKey, status: 'SKIPPED' };
  try {
    const out = await withLease(db, job.name, LEASE_SECONDS, () => job.run(db, now));
    if (!out.ran) {
      // Another process holds the job's lease: give the key back for the next tick.
      await db.jobRun.update({ where: { runKey }, data: { status: 'FAILED', finishedAt: new Date(), error: 'lease held by another worker', attempts: { decrement: 1 } } });
      return { job: job.name, runKey, status: 'SKIPPED' };
    }
    await db.jobRun.update({ where: { runKey }, data: { status: 'COMPLETED', finishedAt: new Date(), summary: out.result as object } });
    logger.info('job completed', { job: job.name, runKey, ...out.result });
    return { job: job.name, runKey, status: 'COMPLETED', summary: out.result };
  } catch (e) {
    const error = e instanceof Error ? e.message.slice(0, 500) : 'unknown error';
    await db.jobRun.update({ where: { runKey }, data: { status: 'FAILED', finishedAt: new Date(), error } });
    logger.error('job failed', { job: job.name, runKey, ...describeError(e) });
    return { job: job.name, runKey, status: 'FAILED', error };
  }
}

/** Runs every due job once. */
export async function tick(db: Db, now = new Date()): Promise<RunOutcome[]> {
  const out: RunOutcome[] = [];
  for (const job of JOBS) {
    const key = job.periodKey(now);
    if (key) out.push(await runJob(db, job, key, now));
  }
  return out;
}

/** A System Admin's "run now": its own run key, so it never consumes the scheduled period. */
export async function runNow(db: Db, name: string, now = new Date()) {
  const job = JOBS.find((j) => j.name === name);
  if (!job) return null;
  return runJob(db, job, `${name}:manual:${now.toISOString()}`, now);
}

/** Starts the minute timer; returns a stop function. Ticks never overlap. */
export function startScheduler(db: Db, intervalMs = 60_000) {
  let running = false;
  const beat = async () => {
    if (running) return;
    running = true;
    try { await tick(db); } catch (e) { logger.error('scheduler tick failed', describeError(e)); } finally { running = false; }
  };
  const timer = setInterval(() => void beat(), intervalMs);
  void beat();
  logger.info('scheduler started', { jobs: JOBS.map((j) => `${j.name} (${j.schedule})`).join('; ') });
  return () => clearInterval(timer);
}
