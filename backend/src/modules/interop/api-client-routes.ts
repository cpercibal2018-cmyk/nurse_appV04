// Nursing Administration → API clients (D-63): a System Admin registers the
// systems that may call the FHIR API, replaces a secret, or revokes a client.
// The secret is returned once, on create and on replacement; every change is
// audited HIGH.

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { sha256hex } from '../../lib/tokens.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import { FHIR_SCOPES, newClientId, newClientSecret } from './api-clients.js';

export const CreateClientBody = z.strictObject({
  name: z.string().trim().min(2).max(100),
  scopes: z.array(z.enum(FHIR_SCOPES)).min(1).default([...FHIR_SCOPES]).transform((s) => [...new Set(s)]),
});
const IdParam = z.object({ id: z.coerce.number().int().positive() });

const PUBLIC_FIELDS = {
  id: true, clientId: true, name: true, scopes: true, secretVersion: true, createdAt: true, secretRotatedAt: true, lastTokenAt: true, revokedAt: true,
  createdBy: { select: { id: true, displayName: true } }, revokedBy: { select: { id: true, displayName: true } },
} as const;

export function createApiClientRouter(db: Db) {
  const r = Router();

  r.get('/api-clients', authorize('apiclients.manage'), async (_req, res) => {
    const items = await db.apiClient.findMany({ select: PUBLIC_FIELDS, orderBy: [{ revokedAt: { sort: 'desc', nulls: 'first' } }, { name: 'asc' }] });
    res.json({ items, scopes: FHIR_SCOPES });
  });

  r.post('/api-clients', authorize('apiclients.manage'), async (req, res) => {
    const body = CreateClientBody.parse(req.body);
    const actor = authOf(res).user.id;
    const clash = await db.apiClient.findFirst({ where: { revokedAt: null, name: { equals: body.name, mode: 'insensitive' } }, select: { id: true } });
    if (clash) throw new HttpError(409, 'API_CLIENT_NAME_TAKEN', 'A live API client already has this name');
    const secret = newClientSecret();
    const client = await db.$transaction(async (tx) => {
      const c = await tx.apiClient.create({ data: { clientId: newClientId(), name: body.name, scopes: body.scopes, secretHash: sha256hex(secret), createdById: actor }, select: PUBLIC_FIELDS });
      await appendAudit(tx, {
        actorUserId: actor, action: 'API_CLIENT_CREATED', resource: 'api_client', resourceId: c.id,
        changes: { clientId: c.clientId, name: c.name, scopes: c.scopes }, requestId: res.locals.requestId, priority: 'HIGH',
      });
      return c;
    });
    res.status(201).json({ client, clientSecret: secret });
  });

  r.post('/api-clients/:id/secret', authorize('apiclients.manage'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const actor = authOf(res).user.id;
    const secret = newClientSecret();
    const client = await db.$transaction(async (tx) => {
      const found = await tx.apiClient.findUnique({ where: { id }, select: { revokedAt: true } });
      if (!found) throw new HttpError(404, 'NOT_FOUND', 'No such API client');
      if (found.revokedAt) throw new HttpError(409, 'API_CLIENT_REVOKED', 'This API client is revoked');
      const c = await tx.apiClient.update({ where: { id }, data: { secretHash: sha256hex(secret), secretVersion: { increment: 1 }, secretRotatedAt: new Date() }, select: PUBLIC_FIELDS });
      await appendAudit(tx, {
        actorUserId: actor, action: 'API_CLIENT_SECRET_REPLACED', resource: 'api_client', resourceId: id,
        changes: { clientId: c.clientId, secretVersion: c.secretVersion }, requestId: res.locals.requestId, priority: 'HIGH',
      });
      return c;
    });
    res.json({ client, clientSecret: secret });
  });

  r.post('/api-clients/:id/revoke', authorize('apiclients.manage'), async (req, res) => {
    const { id } = IdParam.parse(req.params);
    const actor = authOf(res).user.id;
    const client = await db.$transaction(async (tx) => {
      const found = await tx.apiClient.findUnique({ where: { id }, select: { revokedAt: true } });
      if (!found) throw new HttpError(404, 'NOT_FOUND', 'No such API client');
      if (found.revokedAt) throw new HttpError(409, 'API_CLIENT_REVOKED', 'This API client is already revoked');
      const c = await tx.apiClient.update({ where: { id }, data: { revokedAt: new Date(), revokedById: actor }, select: PUBLIC_FIELDS });
      await appendAudit(tx, {
        actorUserId: actor, action: 'API_CLIENT_REVOKED', resource: 'api_client', resourceId: id,
        changes: { clientId: c.clientId, name: c.name }, requestId: res.locals.requestId, priority: 'HIGH',
      });
      return c;
    });
    res.json({ client });
  });

  return r;
}
