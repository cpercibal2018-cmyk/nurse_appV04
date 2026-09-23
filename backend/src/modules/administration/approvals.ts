// Four-eyes approvals (spec §8.1; rules R10–R12). Ported from the V03 NestJS
// reference (admin-approval.service.ts): the request row is locked FOR UPDATE
// so two approvers cannot both proceed, only PENDING requests can be decided,
// the approver must differ from the initiator, and the approved action runs in
// the same transaction as the status change — if it fails, both roll back and
// the request stays PENDING.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { scopeCovers, unitScope, unitsOfScope, type AuthContext } from '../users/access.js';
import type { ApprovalPayload, RoleAssignmentService } from '../users/role-assignments.js';

export const DecideBody = z.strictObject({
  reason: z.string().trim().min(5, 'A decision needs a reason of at least 5 characters (R4)').max(1000),
});
export const ListApprovalsQuery = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'EXECUTED']).default('PENDING') });

const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;

interface LockedRow { id: number; initiator_id: number; status: string; action_type: string; payload: ApprovalPayload }

export function createApprovalService(db: Db, roles: RoleAssignmentService) {
  async function list(auth: AuthContext, q: z.infer<typeof ListApprovalsQuery>) {
    const rows = await db.approvalRequest.findMany({
      where: { status: q.status },
      include: { initiator: { select: { displayName: true, email: true } }, approver: { select: { displayName: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    // Show only requests whose scope the caller covers (they could not approve the rest).
    const scope = await unitScope(db, auth, ADMIN_ROLES);
    const visible = [];
    for (const r of rows) {
      const p = r.payload as unknown as ApprovalPayload;
      const target = p.kind === 'GRANT'
        ? { scopeType: p.grant.scopeType, scopeIds: p.grant.scopeIds }
        : { scopeType: p.update.scopeType ?? 'SYSTEM', scopeIds: p.update.scopeIds ?? [] };
      const units = await unitsOfScope(db, target.scopeType, target.scopeIds);
      if (units === 'ALL' ? scope.all : scopeCovers(scope, units)) visible.push(r);
    }
    return { items: visible, total: visible.length };
  }

  async function lockPending(tx: Parameters<Parameters<Db['$transaction']>[0]>[0], id: number, approverId: number) {
    const rows = await tx.$queryRaw<LockedRow[]>`
      SELECT id, initiator_id, status::text AS status, action_type, payload FROM approval_requests WHERE id = ${id} FOR UPDATE`;
    const req = rows[0];
    if (!req) throw notFound('Approval request not found');
    if (req.status !== 'PENDING') throw new HttpError(409, 'APPROVAL_NOT_PENDING', `This request is already ${req.status}`);
    if (req.initiator_id === approverId) throw new HttpError(403, 'SELF_APPROVAL_FORBIDDEN', 'A request must be approved by a different administrator (R11)');
    return req;
  }

  async function approve(auth: AuthContext, id: number, reason: string, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPending(tx, id, auth.user.id);
      // The action runs as the approver: every grant rule is checked again for them.
      const resultId = await roles.executeApproved(tx, auth, req.payload, id, requestId);
      const now = new Date();
      await tx.approvalRequest.update({ where: { id }, data: { status: 'EXECUTED', approverId: auth.user.id, reason, decidedAt: now, executedAt: now } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'APPROVAL_EXECUTED', resource: 'approval_request', resourceId: id,
        changes: { initiatorId: req.initiator_id, approverId: auth.user.id, actionType: req.action_type, reason, resultId }, requestId, priority: 'HIGH',
      });
      return { id, status: 'EXECUTED' as const, resultId };
    });
  }

  async function reject(auth: AuthContext, id: number, reason: string, requestId?: string) {
    return db.$transaction(async (tx) => {
      const req = await lockPending(tx, id, auth.user.id);
      await tx.approvalRequest.update({ where: { id }, data: { status: 'REJECTED', approverId: auth.user.id, reason, decidedAt: new Date() } });
      await appendAudit(tx, {
        actorUserId: auth.user.id, action: 'APPROVAL_REJECTED', resource: 'approval_request', resourceId: id,
        changes: { initiatorId: req.initiator_id, approverId: auth.user.id, actionType: req.action_type, reason }, requestId, priority: 'HIGH',
      });
      return { id, status: 'REJECTED' as const };
    });
  }

  return { list, approve, reject };
}
