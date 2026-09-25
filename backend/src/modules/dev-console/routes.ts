// Dev Console (D-59): the SMS inbox. While SMS_DRIVER=mock the SMS gateway keeps
// every outgoing text in mock_sms_outbox instead of sending it; System Admins read
// them here, newest first, and can send a test text to show the flow. The inbox
// holds phone numbers, so it is System Admin only and purged after 30 days.
//
// D-64: the simulated SCFHS registry. While SCFHS_DRIVER=mock, licence checks are
// answered from mock_scfhs_registry; a System Admin sets what "SCFHS" says for a
// registration number (valid, expired, suspended, revoked, or ERROR for an
// outage) to demonstrate each outcome. Synthetic entries only.

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { maskPhone, normalizePhone, SMS_MAX_LENGTH, SMS_PHONE, type SmsGateway } from '../../lib/sms.js';
import { isIsoDate } from '../../lib/dates.js';
import { maskReg, normalizeReg, SCFHS_REG, type ScfhsDriver } from '../../lib/scfhs.js';
import { authOf, authorize } from '../../middleware/authorize.js';

export const InboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
export const TestSmsBody = z.strictObject({
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(SMS_PHONE, 'Phone: international format, e.g. +966501234567')),
  message: z.string().trim().min(1).max(SMS_MAX_LENGTH),
});

export const RegistryParam = z.object({ reg: z.string().transform(normalizeReg).pipe(z.string().regex(SCFHS_REG, 'Registration number: letters, digits and hyphens')) });
export const RegistryBody = z.strictObject({
  status: z.enum(['VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'ERROR']),
  expiryDate: z.string().refine(isIsoDate, 'YYYY-MM-DD').nullable().default(null),
  specialty: z.string().trim().max(200).nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});

export function createDevConsoleRouter(db: Db, sms: SmsGateway, scfhsDriver: ScfhsDriver) {
  const r = Router();

  r.get('/dev-console/sms-inbox', authorize('devconsole.sms.read'), async (req, res) => {
    const { limit } = InboxQuery.parse(req.query);
    const [items, total] = await Promise.all([
      db.mockSmsOutbox.findMany({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit }),
      db.mockSmsOutbox.count(),
    ]);
    res.json({ driver: sms.driver, items, total });
  });

  r.post('/dev-console/sms-inbox/test', authorize('devconsole.sms.send'), async (req, res) => {
    const body = TestSmsBody.parse(req.body);
    const accepted = await sms.send(body.phone, body.message);
    await appendAudit(db, {
      actorUserId: authOf(res).user.id, action: 'SMS_TEST_SENT', resource: 'sms', changes: { driver: sms.driver, phone: maskPhone(body.phone), accepted }, requestId: res.locals.requestId,
    });
    if (!accepted) throw new HttpError(502, 'SMS_NOT_ACCEPTED', sms.driver === 'mock' ? 'The text could not be saved to the SMS inbox' : 'The SMS gateway did not accept the text');
    res.status(201).json({ accepted, driver: sms.driver });
  });

  r.get('/dev-console/scfhs-registry', authorize('devconsole.scfhs.read'), async (_req, res) => {
    const items = await db.mockScfhsRegistry.findMany({ orderBy: { registrationNumber: 'asc' }, take: 1000 });
    res.json({ driver: scfhsDriver, items });
  });

  r.put('/dev-console/scfhs-registry/:reg', authorize('devconsole.scfhs.manage'), async (req, res) => {
    const { reg } = RegistryParam.parse(req.params);
    const body = RegistryBody.parse(req.body);
    const entry = await db.$transaction(async (tx) => {
      const e = await tx.mockScfhsRegistry.upsert({ where: { registrationNumber: reg }, update: body, create: { registrationNumber: reg, ...body } });
      await appendAudit(tx, { actorUserId: authOf(res).user.id, action: 'SCFHS_REGISTRY_SET', resource: 'scfhs_registry', resourceId: maskReg(reg), changes: { status: body.status, expiryDate: body.expiryDate }, requestId: res.locals.requestId });
      return e;
    });
    res.json(entry);
  });

  r.delete('/dev-console/scfhs-registry/:reg', authorize('devconsole.scfhs.manage'), async (req, res) => {
    const { reg } = RegistryParam.parse(req.params);
    const removed = await db.$transaction(async (tx) => {
      const { count } = await tx.mockScfhsRegistry.deleteMany({ where: { registrationNumber: reg } });
      if (count) await appendAudit(tx, { actorUserId: authOf(res).user.id, action: 'SCFHS_REGISTRY_REMOVED', resource: 'scfhs_registry', resourceId: maskReg(reg), requestId: res.locals.requestId });
      return count;
    });
    if (!removed) throw new HttpError(404, 'NOT_FOUND', 'No registry entry for this number');
    res.status(204).end();
  });

  return r;
}
