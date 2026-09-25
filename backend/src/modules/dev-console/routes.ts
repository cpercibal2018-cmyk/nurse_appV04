// Dev Console (D-59): the SMS inbox. While SMS_DRIVER=mock the SMS gateway keeps
// every outgoing text in mock_sms_outbox instead of sending it; System Admins read
// them here, newest first, and can send a test text to show the flow. The inbox
// holds phone numbers, so it is System Admin only and purged after 30 days.

import { Router } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import type { Db } from '../../lib/prisma.js';
import { maskPhone, normalizePhone, SMS_MAX_LENGTH, SMS_PHONE, type SmsGateway } from '../../lib/sms.js';
import { authOf, authorize } from '../../middleware/authorize.js';

export const InboxQuery = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
export const TestSmsBody = z.strictObject({
  phone: z.string().transform(normalizePhone).pipe(z.string().regex(SMS_PHONE, 'Phone: international format, e.g. +966501234567')),
  message: z.string().trim().min(1).max(SMS_MAX_LENGTH),
});

export function createDevConsoleRouter(db: Db, sms: SmsGateway) {
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

  return r;
}
