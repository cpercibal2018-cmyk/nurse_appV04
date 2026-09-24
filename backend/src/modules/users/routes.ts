import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../lib/prisma.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { createApprovalService, DecideBody, ListApprovalsQuery } from '../administration/approvals.js';
import { BaselinePreviewBody, BaselineRequestBody, type BaselineImportService } from '../administration/baseline-import.js';
import { createPamService, ElevateBody } from '../administration/pam.js';
import { CreateAccountBody, ListAccountsQuery, UpdateAccountBody, type createAccountService } from './accounts.js';
import type { InvitationService } from './invitations.js';
import type { PasswordResetService } from './password-reset.js';
import { ACCESS_MATRIX, PERMISSIONS } from './permissions.js';
import type { CatalogService } from '../credentials/catalog.js';
import { GrantBody, ListQuery, RevokeBody, UpdateBody, type RoleAssignmentService } from './role-assignments.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });

/** Accounts, role assignments, approvals and PAM. Mounted on the protected router (app.ts). */
export function createUsersRouter(
  db: Db,
  accounts: ReturnType<typeof createAccountService>,
  roles: RoleAssignmentService,
  catalog: CatalogService,
  baseline: BaselineImportService,
  invitations: InvitationService,
  resets: PasswordResetService,
) {
  const router = Router();
  const approvals = createApprovalService(db, roles, catalog, baseline);
  const pam = createPamService(db);

  // ── Accounts ──────────────────────────────────────────────────────────────
  // Assisted password reset (D-50): the link goes to the account's own e-mail.
  router.post('/users/:id/password-reset', authorize('accounts.write'), async (req, res) => {
    res.status(202).json(await resets.sendAssisted(authOf(res), IdParam.parse(req.params).id, res.locals.requestId));
  });
  // Registration invitations (spec §3.2): the link is e-mailed, never returned.
  router.post('/employees/:id/invitations', authorize('accounts.write'), async (req, res) => {
    res.status(201).json(await invitations.issue(authOf(res), IdParam.parse(req.params).id, res.locals.requestId));
  });
  router.get('/employees/:id/invitations', authorize('accounts.read'), async (req, res) => {
    res.json(await invitations.list(authOf(res), IdParam.parse(req.params).id));
  });
  router.get('/users', authorize('accounts.read'), async (req, res) => {
    res.json(await accounts.list(authOf(res), ListAccountsQuery.parse(req.query)));
  });
  router.post('/users', authorize('accounts.write'), idempotent(db, 'users.create'), async (req, res) => {
    res.status(201).json(await accounts.create(authOf(res), CreateAccountBody.parse(req.body), res.locals.requestId));
  });
  router.patch('/users/:id', authorize('accounts.write'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await accounts.update(authOf(res), id, UpdateAccountBody.parse(req.body), res.locals.requestId));
  });

  // ── Role assignments ──────────────────────────────────────────────────────
  router.get('/roles/matrix', authorize('matrix.read'), (_req, res) => {
    res.json({ matrix: ACCESS_MATRIX, permissions: PERMISSIONS });
  });
  router.get('/role-assignments', authorize('roles.read'), async (req, res) => {
    res.json(await roles.list(authOf(res), ListQuery.parse(req.query)));
  });
  router.post('/role-assignments', authorize('roles.write'), idempotent(db, 'role-assignments.grant'), async (req, res) => {
    const out = await roles.grant(authOf(res), GrantBody.parse(req.body), res.locals.requestId);
    res.status(out.status === 'GRANTED' ? 201 : 202).json(out);
  });
  router.patch('/role-assignments/:id', authorize('roles.write'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const out = await roles.update(authOf(res), id, UpdateBody.parse(req.body), res.locals.requestId);
    res.status(out.status === 'GRANTED' ? 200 : 202).json(out);
  });
  router.post('/role-assignments/:id/revoke', authorize('roles.write'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    await roles.revoke(authOf(res), id, RevokeBody.parse(req.body).reason, res.locals.requestId);
    res.status(204).end();
  });

  // ── Hospital baseline import (P7): preview, then a four-eyes request ──────
  router.post('/admin/baseline-import/preview', authorize('baseline.import'), async (req, res) => {
    res.json(await baseline.preview(authOf(res), BaselinePreviewBody.parse(req.body).file));
  });
  router.post('/admin/baseline-import', authorize('baseline.import'), async (req, res) => {
    const body = BaselineRequestBody.parse(req.body);
    const out = await baseline.request(authOf(res), body.file, body.reason, res.locals.requestId);
    res.status(out.status === 'PENDING_APPROVAL' ? 202 : 201).json(out);
  });

  // ── Four-eyes approvals ───────────────────────────────────────────────────
  router.get('/approvals', authorize('approvals.read'), async (req, res) => {
    res.json(await approvals.list(authOf(res), ListApprovalsQuery.parse(req.query)));
  });
  router.post('/approvals/:id/approve', authorize('approvals.decide'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await approvals.approve(authOf(res), id, DecideBody.parse(req.body).reason, res.locals.requestId));
  });
  router.post('/approvals/:id/reject', authorize('approvals.decide'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await approvals.reject(authOf(res), id, DecideBody.parse(req.body).reason, res.locals.requestId));
  });
  router.post('/approvals/:id/withdraw', authorize('approvals.decide'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    res.json(await approvals.withdraw(authOf(res), id, DecideBody.parse(req.body).reason, res.locals.requestId));
  });

  // ── PAM (any signed-in user; the service requires a System Admin assignment) ─
  router.get('/pam/status', async (_req, res) => { res.json(await pam.status(authOf(res))); });
  router.post('/pam/elevate', async (req, res) => {
    res.json(await pam.elevate(authOf(res), ElevateBody.parse(req.body), res.locals.requestId));
  });
  router.post('/pam/end', async (_req, res) => {
    await pam.end(authOf(res), res.locals.requestId);
    res.status(204).end();
  });

  return router;
}
