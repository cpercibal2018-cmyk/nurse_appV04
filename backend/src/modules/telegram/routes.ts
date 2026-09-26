// Telegram account linking routes (D-66).
//
// Signed in: the account's own link (status, new link, disconnect); HR / a
// System Admin creates a link for an account in scope; the Dev Console
// simulates a message to the bot while NOTIFICATION_DRIVER=mock.
// Public: the webhook Telegram posts updates to (TELEGRAM_UPDATES=webhook),
// guarded by the secret Telegram sends in X-Telegram-Bot-Api-Secret-Token.

import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import { describeError, logger } from '../../lib/logger.js';
import type { Db } from '../../lib/prisma.js';
import { maskChatId, TELEGRAM_CHAT_ID } from '../../lib/telegram.js';
import type { TelegramUpdate } from '../../lib/telegram-updates.js';
import { constantTimeEqual } from '../../lib/tokens.js';
import { authOf, authorize } from '../../middleware/authorize.js';
import type { TelegramLinking } from './linking.js';

const IdParam = z.object({ id: z.coerce.number().int().positive() });
export const SimulatedMessage = z.strictObject({
  chatId: z.string().trim().regex(TELEGRAM_CHAT_ID, 'Chat id: digits, e.g. 123456789'),
  text: z.string().trim().min(1).max(4096),
});

export function createTelegramRouter(db: Db, linking: TelegramLinking, driver: Env['NOTIFICATION_DRIVER']) {
  const r = Router();

  r.get('/me/telegram', async (_req, res) => {
    res.json(await linking.status(authOf(res)));
  });

  r.post('/me/telegram/link', async (_req, res) => {
    res.status(201).json(await linking.linkSelf(authOf(res), res.locals.requestId));
  });

  r.delete('/me/telegram', async (_req, res) => {
    await linking.unlinkSelf(authOf(res), res.locals.requestId);
    res.status(204).end();
  });

  r.post('/users/:id/telegram/link', authorize('accounts.write'), async (req, res) => {
    res.status(201).json(await linking.linkFor(authOf(res), IdParam.parse(req.params).id, res.locals.requestId));
  });

  // Offline testing: what Telegram would deliver if this chat sent the text to the bot.
  r.post('/dev-console/telegram-inbox/simulate', authorize('devconsole.telegram.send'), async (req, res) => {
    if (driver !== 'mock') throw new HttpError(409, 'TELEGRAM_LIVE', 'Simulated messages are for the mock driver only; send the real message to the bot');
    const body = SimulatedMessage.parse(req.body);
    await linking.handleUpdate({ update_id: 0, message: { chat: { id: Number(body.chatId), type: 'private' }, text: body.text } });
    await appendAudit(db, { actorUserId: authOf(res).user.id, action: 'TELEGRAM_MESSAGE_SIMULATED', resource: 'telegram', changes: { chatId: maskChatId(body.chatId), command: body.text.split(/\s+/)[0] }, requestId: res.locals.requestId });
    res.status(201).json({ handled: true });
  });

  return r;
}

/** POST /api/v1/telegram/webhook. Always 200 once the secret matches, so Telegram does not re-send a message that failed here. */
export function telegramWebhook(env: Env, linking: TelegramLinking): RequestHandler {
  const enabled = env.NOTIFICATION_DRIVER === 'telegram' && env.TELEGRAM_UPDATES === 'webhook';
  return async (req, res) => {
    if (!enabled) throw new HttpError(404, 'NOT_FOUND', 'Not found');
    const secret = req.get('x-telegram-bot-api-secret-token') ?? '';
    if (!constantTimeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) throw new HttpError(401, 'UNAUTHENTICATED', 'Not authenticated');
    try {
      await linking.handleUpdate(req.body as TelegramUpdate);
    } catch (e) {
      logger.error('telegram update not handled', { updateId: (req.body as { update_id?: number })?.update_id ?? null, ...describeError(e) });
    }
    res.json({ ok: true });
  };
}
