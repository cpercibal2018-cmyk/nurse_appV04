// Just-in-time elevation for System Admins (spec §8.1 PAM; rule R13). System
// Admin assignments are dormant until the holder elevates with a documented
// reason for a limited window. Ported from the V03 NestJS reference
// (pam.service.ts): reason ≥ 10 characters, 1–4 hours, default 2 (the spec's
// example window). Expired elevations are ignored by the access check at once;
// the daily transition job (jobs/daily-transition.ts) removes and audits them.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { activePam, type AuthContext } from '../users/access.js';

export const ElevateBody = z.strictObject({
  reason: z.string().trim().min(10, 'Elevation needs a documented reason of at least 10 characters').max(1000),
  durationHours: z.number().int().min(1).max(4).default(2),
});

export function createPamService(db: Db) {
  async function elevate(auth: AuthContext, body: z.infer<typeof ElevateBody>, requestId?: string) {
    if (!auth.grants.some((g) => g.role === 'SYSTEM_ADMIN')) {
      throw new HttpError(403, 'NOT_SYSTEM_ADMIN', 'Only holders of a System Admin assignment can elevate');
    }
    const expiresAt = new Date(Date.now() + body.durationHours * 3600_000);
    await db.$transaction(async (tx) => {
      await tx.privilegedSession.upsert({
        where: { userId: auth.user.id },
        update: { reason: body.reason, elevatedAt: new Date(), expiresAt },
        create: { userId: auth.user.id, reason: body.reason, expiresAt },
      });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'PAM_ELEVATED', resource: 'user', resourceId: auth.user.id,
        changes: { reason: body.reason, durationHours: body.durationHours, expiresAt: expiresAt.toISOString() }, requestId, priority: 'HIGH',
      });
    });
    return { active: true, expiresAt };
  }

  async function status(auth: AuthContext) {
    const pam = await activePam(db, auth.user.id);
    return { eligible: auth.grants.some((g) => g.role === 'SYSTEM_ADMIN'), active: pam !== null, expiresAt: pam?.expiresAt ?? null };
  }

  async function end(auth: AuthContext, requestId?: string) {
    await db.$transaction(async (tx) => {
      const removed = await tx.privilegedSession.deleteMany({ where: { userId: auth.user.id } });
      if (removed.count > 0) {
        await appendAudit(tx, { actorUserId: auth.user.id, action: 'PAM_ENDED', resource: 'user', resourceId: auth.user.id, requestId, priority: 'HIGH' });
      }
    });
  }

  return { elevate, status, end };
}
