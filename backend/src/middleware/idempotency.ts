// Idempotency-Key for creating operations marked [I] in docs/API.md.
//
// - The key is a client-generated UUID, unique per actor.
// - Same key + same request → the stored response is replayed (no second write).
// - Same key + different request → 422, never a silent replay of something else.
// - A request still processing → 409 while its lease is live; an expired lease
//   or a failed (5xx) attempt may be retaken.
// Responses of [I] endpoints carry identifiers only, so stored bodies hold no
// personal data (schema comment on IdempotencyKey.responseBody).

import type { RequestHandler } from 'express';
import { Prisma } from '../lib/prisma.js';
import type { Db } from '../lib/prisma.js';
import { HttpError } from '../lib/http-errors.js';
import { sha256hex } from '../lib/tokens.js';
import { authOf } from './authorize.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LEASE_MS = 60_000;
const RETENTION_MS = 24 * 3600_000;

export function idempotent(db: Db, operation: string): RequestHandler {
  return async (req, res, next) => {
    const key = req.get('idempotency-key') ?? '';
    if (!UUID.test(key)) return next(new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'An Idempotency-Key header (UUID) is required'));

    const actorUserId = authOf(res).user.id;
    const requestHash = sha256hex(`${req.method} ${req.originalUrl}\n${JSON.stringify(req.body ?? null)}`);
    const now = new Date();
    const lease = new Date(now.getTime() + LEASE_MS);

    let row;
    try {
      row = await db.idempotencyKey.create({
        data: { key, actorUserId, operation, requestPath: req.originalUrl, requestHash, status: 'PROCESSING', processingLeaseExpiresAt: lease, expiresAt: new Date(now.getTime() + RETENTION_MS) },
      });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      const existing = await db.idempotencyKey.findUniqueOrThrow({ where: { key_actorUserId: { key, actorUserId } } });
      if (existing.requestHash !== requestHash) {
        return next(new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request'));
      }
      if (existing.status === 'COMPLETED' && existing.responseCode !== null) {
        res.set('Idempotent-Replayed', 'true');
        return res.status(existing.responseCode).json(existing.responseBody);
      }
      if (existing.status === 'PROCESSING' && existing.processingLeaseExpiresAt && existing.processingLeaseExpiresAt > now) {
        return next(new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed'));
      }
      // Expired lease or failed attempt: take it over, guarded against a racing taker.
      const taken = await db.idempotencyKey.updateMany({
        where: { id: existing.id, status: existing.status, processingLeaseExpiresAt: existing.processingLeaseExpiresAt },
        data: { status: 'PROCESSING', processingLeaseExpiresAt: lease },
      });
      if (taken.count !== 1) return next(new HttpError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed'));
      row = existing;
    }

    // Record the outcome when the handler answers.
    const id = row.id;
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      const code = res.statusCode;
      const done = code < 500
        ? { status: 'COMPLETED' as const, responseCode: code, responseBody: body as Prisma.InputJsonValue, responseHash: sha256hex(JSON.stringify(body)), completedAt: new Date(), processingLeaseExpiresAt: null }
        : { status: 'FAILED' as const, processingLeaseExpiresAt: null };
      db.idempotencyKey.update({ where: { id }, data: done }).then(() => json(body), (e: unknown) => next(e));
      return res;
    };
    next();
  };
}
