// Business health (spec §10.8): "SLA" signals for the silent failures that a
// liveness probe cannot see. GET /api/v1/system/health/business (System Admin).
//
// - Eligibility: the consistency auditor's last run and 7-day drift rate.
// - Jobs: each scheduled job's last completed run; older than its maxAgeMinutes,
//   or last attempt failed → attention.
// - E-mail (D-47): pending older than 15 minutes, failures in the last 24 hours.
//
// The spec's SCFHS sync freshness and weekly evidence checksum signals belong to
// modules that are not built (§5.4, §5.3 vault) and are not reported.

import { JOBS } from '../../jobs/scheduler.js';
import type { Db } from '../../lib/prisma.js';

export interface Issue { code: string; message: string }

const MINUTE = 60_000;

export async function businessHealth(db: Db, now = new Date()) {
  const issues: Issue[] = [];
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * MINUTE);

  // ── Eligibility consistency ────────────────────────────────────────────────
  const auditRuns = await db.jobRun.findMany({ where: { jobName: 'consistency-audit', status: 'COMPLETED', finishedAt: { gte: weekAgo } }, orderBy: { finishedAt: 'desc' } });
  const checked7d = auditRuns.reduce((n, r) => n + Number((r.summary as { checked?: number } | null)?.checked ?? 0), 0);
  const drifts7d = await db.consistencyAuditLog.count({ where: { detectedAt: { gte: weekAgo } } });
  const last = auditRuns[0];
  const lastSummary = (last?.summary ?? null) as { checked?: number; drifted?: number } | null;
  if (lastSummary?.drifted) issues.push({ code: 'ELIGIBILITY_DRIFT', message: `The last consistency audit corrected ${lastSummary.drifted} nurse(s)` });
  const recentDrifts = await db.consistencyAuditLog.findMany({
    where: { detectedAt: { gte: weekAgo } }, orderBy: { detectedAt: 'desc' }, take: 20,
    select: { employeeId: true, expectedStatus: true, actualStatus: true, detectedAt: true, employee: { select: { jobNumber: true } } },
  });

  // ── Scheduled jobs ─────────────────────────────────────────────────────────
  const jobs = [];
  for (const job of JOBS) {
    const [lastDone, lastAttempt] = await Promise.all([
      db.jobRun.findFirst({ where: { jobName: job.name, status: 'COMPLETED' }, orderBy: { finishedAt: 'desc' }, select: { finishedAt: true } }),
      db.jobRun.findFirst({ where: { jobName: job.name }, orderBy: { startedAt: 'desc' }, select: { status: true, error: true } }),
    ]);
    const ageMinutes = lastDone?.finishedAt ? Math.floor((now.getTime() - lastDone.finishedAt.getTime()) / MINUTE) : null;
    const stale = ageMinutes === null || ageMinutes > job.maxAgeMinutes;
    const failed = lastAttempt?.status === 'FAILED';
    if (stale) issues.push({ code: 'JOB_STALE', message: ageMinutes === null ? `${job.name} has never completed` : `${job.name} last completed ${ageMinutes} minutes ago` });
    if (failed) issues.push({ code: 'JOB_FAILED', message: `${job.name}'s last attempt failed: ${lastAttempt?.error ?? 'unknown error'}` });
    jobs.push({ name: job.name, schedule: job.schedule, lastCompletedAt: lastDone?.finishedAt ?? null, ageMinutes, maxAgeMinutes: job.maxAgeMinutes, stale, lastAttemptFailed: failed });
  }

  // ── E-mail delivery ────────────────────────────────────────────────────────
  const stuckBefore = new Date(now.getTime() - 15 * MINUTE);
  const dayAgo = new Date(now.getTime() - 24 * 60 * MINUTE);
  const [pendingN, pendingO, failedN, failedO, lastN, lastO] = await Promise.all([
    db.notification.count({ where: { emailStatus: 'PENDING', createdAt: { lt: stuckBefore } } }),
    db.emailOutbox.count({ where: { status: 'PENDING', createdAt: { lt: stuckBefore } } }),
    db.notification.count({ where: { emailStatus: 'FAILED', emailLastAt: { gte: dayAgo } } }),
    db.emailOutbox.count({ where: { status: 'FAILED', lastAt: { gte: dayAgo } } }),
    db.notification.findFirst({ where: { emailStatus: 'SENT' }, orderBy: { emailLastAt: 'desc' }, select: { emailLastAt: true } }),
    db.emailOutbox.findFirst({ where: { status: 'SENT' }, orderBy: { lastAt: 'desc' }, select: { lastAt: true } }),
  ]);
  const email = {
    pendingOver15Minutes: pendingN + pendingO,
    failedLast24Hours: failedN + failedO,
    lastSentAt: [lastN?.emailLastAt, lastO?.lastAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null,
  };
  if (email.pendingOver15Minutes > 0) issues.push({ code: 'EMAIL_BACKLOG', message: `${email.pendingOver15Minutes} e-mail(s) waiting more than 15 minutes` });
  if (email.failedLast24Hours > 0) issues.push({ code: 'EMAIL_FAILED', message: `${email.failedLast24Hours} e-mail(s) failed in the last 24 hours` });

  return {
    status: issues.length === 0 ? 'HEALTHY' as const : 'ATTENTION' as const,
    issues,
    eligibility: {
      lastAuditAt: last?.finishedAt ?? null, lastChecked: lastSummary?.checked ?? null, lastDrifted: lastSummary?.drifted ?? null,
      checked7d, drifts7d, driftRate7d: checked7d > 0 ? drifts7d / checked7d : null,
      recentDrifts: recentDrifts.map((d) => ({ employeeId: d.employeeId, jobNumber: d.employee.jobNumber, expected: d.expectedStatus, stored: d.actualStatus, detectedAt: d.detectedAt })),
    },
    jobs,
    email,
    generatedAt: now,
  };
}
