// Telegram messages behind one interface (decision D-66, replacing the SMS
// gateway of D-48 / D-59).
//
// SMS needed a CST-registered Sender ID, and that needed the hospital's
// Commercial Registration; Telegram needs only a bot. NOTIFICATION_DRIVER picks
// the driver:
// - mock: every outgoing message is saved to mock_telegram_outbox and shown in
//   the Dev Console (Nursing Administration → Telegram inbox); nothing leaves
//   the server, so development works offline;
// - telegram: the Bot API (sendMessage).
// Callers depend only on TelegramGateway; createTelegramGateway picks the driver.
//
// Telegram's servers are outside the Kingdom (spec §8.3.6), so a message never
// carries personal data (D-66): a generic prompt and a link to the application.
//
// send() never throws: it answers whether the message was accepted (saved, for
// the mock) and Telegram's message id, after logging why not. A lost message
// must not undo the action that caused it (a sign-in, a notification).

import type { Env } from '../config/env.js';
import { describeError, logger } from './logger.js';
import type { DbClient } from './prisma.js';

export type TelegramDriver = Env['NOTIFICATION_DRIVER'];

export interface SendOptions {
  /** MarkdownV2 (escape dynamic parts with escapeMarkdown); plain text when omitted. */
  markdown?: boolean;
}

export interface SendResult {
  accepted: boolean;
  /** Telegram's message_id (the mock outbox row id for the mock driver), or null when not accepted. */
  messageId: string | null;
}

export interface TelegramGateway {
  readonly driver: TelegramDriver;
  /** Never throws. */
  send(chatId: string, text: string, options?: SendOptions): Promise<SendResult>;
}

/** A chat id: a user (positive) or a group (negative), at most 20 digits. Also a CHECK on the tables. */
export const TELEGRAM_CHAT_ID = /^-?[1-9]\d{0,19}$/;
/** Telegram's limit for one message; also a CHECK on mock_telegram_outbox. */
export const TELEGRAM_MAX_LENGTH = 4096;

/** Logs show only the last four digits of a chat id. */
export const maskChatId = (chatId: string) => (chatId.length > 4 ? `…${chatId.slice(-4)}` : '…');

/** Escapes text for MarkdownV2, where these characters are reserved. */
export const escapeMarkdown = (text: string) => text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');

const NOT_ACCEPTED: SendResult = { accepted: false, messageId: null };

/** The message as it will be sent, or null (logged) when it cannot be. */
function checked(chatId: string, text: string): { chatId: string; text: string } | null {
  const id = chatId.trim();
  const t = text.trim();
  if (!TELEGRAM_CHAT_ID.test(id)) {
    logger.warn('telegram message not sent: the chat id is not valid', { chatId: maskChatId(id) });
    return null;
  }
  if (t.length === 0 || t.length > TELEGRAM_MAX_LENGTH) {
    logger.warn('telegram message not sent: the text is empty or too long', { chatId: maskChatId(id), length: t.length });
    return null;
  }
  return { chatId: id, text: t };
}

/** Saves each message to mock_telegram_outbox instead of sending it. */
export class MockTelegramGateway implements TelegramGateway {
  readonly driver = 'mock' as const;

  constructor(private readonly db: DbClient) {}

  async send(chatId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const m = checked(chatId, text);
    if (!m) return NOT_ACCEPTED;
    try {
      const row = await this.db.mockTelegramOutbox.create({ data: { chatId: m.chatId, messageText: m.text, parseMode: options.markdown ? 'MarkdownV2' : null } });
      return { accepted: true, messageId: String(row.id) };
    } catch (e) {
      logger.error('telegram message not saved to the mock outbox', { chatId: maskChatId(m.chatId), ...describeError(e) });
      return NOT_ACCEPTED;
    }
  }
}

type Fetch = typeof fetch;
export const TELEGRAM_TIMEOUT_MS = 10_000;

/** The live gateway: the Telegram Bot API. The token is a secret: it is never logged. */
export class BotApiTelegramGateway implements TelegramGateway {
  readonly driver = 'telegram' as const;

  constructor(private readonly token: string, private readonly fetchImpl: Fetch = fetch) {}

  async send(chatId: string, text: string, options: SendOptions = {}): Promise<SendResult> {
    const m = checked(chatId, text);
    if (!m) return NOT_ACCEPTED;
    try {
      const res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: m.chatId, text: m.text, parse_mode: options.markdown ? 'MarkdownV2' : undefined, link_preview_options: { is_disabled: true } }),
        signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
      });
      const body = (await res.json().catch(() => null)) as { ok?: boolean; result?: { message_id?: number }; error_code?: number; description?: string } | null;
      if (!res.ok || !body?.ok || body.result?.message_id === undefined) {
        logger.warn('telegram message not accepted', { chatId: maskChatId(m.chatId), status: res.status, error: body?.description?.slice(0, 200) ?? null });
        return NOT_ACCEPTED;
      }
      return { accepted: true, messageId: String(body.result.message_id) };
    } catch (e) {
      // Only the error's name (e.g. TimeoutError): its message could quote the URL, which holds the token.
      logger.warn('telegram message not sent: the Bot API could not be reached', { chatId: maskChatId(m.chatId), error: e instanceof Error ? e.name : 'unknown' });
      return NOT_ACCEPTED;
    }
  }
}

/** The binding: NOTIFICATION_DRIVER=mock → MockTelegramGateway; telegram → BotApiTelegramGateway. */
export function createTelegramGateway(env: Pick<Env, 'NOTIFICATION_DRIVER' | 'TELEGRAM_BOT_TOKEN'>, db: DbClient): TelegramGateway {
  if (env.NOTIFICATION_DRIVER === 'mock') return new MockTelegramGateway(db);
  return new BotApiTelegramGateway(env.TELEGRAM_BOT_TOKEN);
}
