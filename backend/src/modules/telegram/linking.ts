// Connecting an account to Telegram (D-66).
//
// 1. The account holder (or HR / a System Admin for an account in scope) asks
//    for a link: https://t.me/<bot>?start=<token>, single-use, 15 minutes.
//    Only the token's SHA-256 is stored; a new link replaces open ones.
// 2. Opening it in Telegram sends the bot "/start <token>" from the person's
//    private chat. The account is linked to that chat: one chat per account and
//    one account per chat (linking moves a chat from an earlier account).
// 3. "/stop" in the chat, or Disconnect in the application, unlinks it.
// Every link and unlink is audited, and the account gets an in-app security
// notice. Replies from the bot carry no personal data (Telegram is outside the
// Kingdom): not even the account's name or e-mail.

import { appendAudit } from '../../lib/audit.js';
import { HttpError, notFound } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';
import { maskChatId, type TelegramGateway } from '../../lib/telegram.js';
import type { TelegramUpdate } from '../../lib/telegram-updates.js';
import { randomToken, sha256hex } from '../../lib/tokens.js';
import { assertEmployeeInScope } from '../users/accounts.js';
import { unitScope, type AuthContext } from '../users/access.js';

export const LINK_TTL_MINUTES = 15;
const ADMIN_ROLES = ['HR_ADMIN', 'SYSTEM_ADMIN'] as const;
const hashToken = (token: string) => sha256hex(`telegram-link:${token}`);

export interface LinkOffer {
  /** https://t.me/<bot>?start=<token>; null while no bot username is configured (mock driver). */
  url: string | null;
  /** The /start parameter, for the Dev Console simulator and for typing it by hand. */
  startParameter: string;
  expiresAt: Date;
}

const REPLY = {
  linked: 'AIGH Nursing Workforce: this chat is now connected to your account. You will get a short message here when a new notification is waiting in the application. Send /stop to disconnect.\n\n'
    + 'تم ربط هذه المحادثة بحسابك في نظام القوى العاملة التمريضية. ستصلك هنا رسالة قصيرة عند وجود إشعار جديد. أرسل /stop لإلغاء الربط.',
  invalid: 'AIGH Nursing Workforce: this link has expired or was already used. Create a new one in the application (My account → Telegram).\n\n'
    + 'انتهت صلاحية هذا الرابط أو استُخدم من قبل. أنشئ رابطاً جديداً من التطبيق (حسابي ← تيليجرام).',
  notPrivate: 'AIGH Nursing Workforce: open the link in a private chat with this bot, not in a group.\n\nافتح الرابط في محادثة خاصة مع البوت، لا في مجموعة.',
  unlinked: 'AIGH Nursing Workforce: this chat is no longer connected. You will not get messages here.\n\nتم إلغاء ربط هذه المحادثة. لن تصلك رسائل هنا.',
  notLinked: 'AIGH Nursing Workforce: this chat is not connected to an account.\n\nهذه المحادثة غير مرتبطة بأي حساب.',
  help: (chatId: string) => 'AIGH Nursing Workforce: to connect, open the application, go to My account → Telegram and use the link shown there. '
    + `This chat's id is ${chatId}.\n\nللربط افتح التطبيق، ثم حسابي ← تيليجرام، واستخدم الرابط الظاهر هناك.`,
};

export function createTelegramLinking(db: Db, telegram: TelegramGateway, botUsername: string) {
  async function issue(tx: DbClient, userId: number, issuedById: number, now: Date): Promise<LinkOffer> {
    const token = randomToken(32); // 43 base64url characters: within Telegram's 64 for a start parameter
    await tx.telegramLinkToken.deleteMany({ where: { userId, usedAt: null } });
    const expiresAt = new Date(now.getTime() + LINK_TTL_MINUTES * 60_000);
    await tx.telegramLinkToken.create({ data: { userId, tokenHash: hashToken(token), issuedById, expiresAt } });
    return { url: botUsername ? `https://t.me/${botUsername}?start=${token}` : null, startParameter: token, expiresAt };
  }

  async function notice(tx: DbClient, userId: number, key: string, title: string, message: string, titleAr: string, messageAr: string) {
    await tx.notification.createMany({ data: [{ recipientId: userId, type: 'SECURITY', priority: 'MEDIUM', title, message, titleAr, messageAr, eventKey: `telegram:${key}` }], skipDuplicates: true });
  }

  async function unlinkIn(tx: DbClient, userId: number, actorUserId: number | null, via: string, requestId?: string) {
    const u = await tx.user.findUnique({ where: { id: userId }, select: { telegramChatId: true } });
    if (!u?.telegramChatId) return false;
    await tx.user.update({ where: { id: userId }, data: { telegramChatId: null, telegramLinkedAt: null } });
    await appendAudit(tx, { actorUserId, action: 'TELEGRAM_UNLINKED', resource: 'user', resourceId: userId, changes: { chatId: maskChatId(u.telegramChatId), via }, requestId, priority: 'HIGH' });
    await notice(tx, userId, `unlinked:${Date.now()}`, 'Telegram disconnected', 'Your account no longer sends Telegram messages. Connect again in My account → Telegram.',
      'تم إلغاء ربط تيليجرام', 'لم يعد حسابك يرسل رسائل تيليجرام. يمكنك الربط مجدداً من حسابي ← تيليجرام.');
    return true;
  }

  /** The signed-in account's own link state. */
  async function status(auth: AuthContext) {
    const u = await db.user.findUniqueOrThrow({ where: { id: auth.user.id }, select: { telegramChatId: true, telegramLinkedAt: true } });
    return { linked: Boolean(u.telegramChatId), linkedAt: u.telegramLinkedAt, botUsername: botUsername || null, driver: telegram.driver, available: !auth.user.isBreakGlass };
  }

  /** A link for the signed-in account. */
  async function linkSelf(auth: AuthContext, requestId?: string, now = new Date()) {
    if (auth.user.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is alerted through BREAK_GLASS_ALERT_TELEGRAM_CHAT_IDS, not a linked chat');
    return db.$transaction(async (tx) => {
      const offer = await issue(tx, auth.user.id, auth.user.id, now);
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'TELEGRAM_LINK_CREATED', resource: 'user', resourceId: auth.user.id, changes: { expiresAt: offer.expiresAt.toISOString() }, requestId });
      return offer;
    });
  }

  /** HR / System Admin: a link for an account in scope, to show the person as a QR code. */
  async function linkFor(auth: AuthContext, userId: number, requestId?: string, now = new Date()) {
    const target = await db.user.findUnique({ where: { id: userId }, select: { id: true, isActive: true, isBreakGlass: true, employeeId: true } });
    if (!target) throw notFound('Account not found');
    if (target.isBreakGlass) throw new HttpError(403, 'BREAK_GLASS_ACCOUNT_PROTECTED', 'The break-glass account is managed outside the application');
    if (!target.isActive) throw new HttpError(409, 'ACCOUNT_INACTIVE', 'This account is deactivated');
    await assertEmployeeInScope(db, await unitScope(db, auth, ADMIN_ROLES), target.employeeId);
    return db.$transaction(async (tx) => {
      const offer = await issue(tx, userId, auth.user.id, now);
      await appendAudit(tx, { actorUserId: auth.user.id, action: 'TELEGRAM_LINK_CREATED', resource: 'user', resourceId: userId, changes: { expiresAt: offer.expiresAt.toISOString(), forAnotherAccount: true }, requestId });
      return offer;
    });
  }

  async function unlinkSelf(auth: AuthContext, requestId?: string) {
    const done = await db.$transaction((tx) => unlinkIn(tx, auth.user.id, auth.user.id, 'application', requestId));
    if (!done) throw new HttpError(409, 'TELEGRAM_NOT_LINKED', 'This account is not connected to Telegram');
  }

  /** "/start <token>": links the chat to the token's account. Answers the reply to send. */
  async function redeem(chatId: string, token: string, now = new Date()): Promise<string> {
    return db.$transaction(async (tx) => {
      const h = hashToken(token);
      await tx.$queryRaw`SELECT id FROM telegram_link_tokens WHERE token_hash = ${h} FOR UPDATE`;
      const t = await tx.telegramLinkToken.findUnique({ where: { tokenHash: h }, include: { user: { select: { id: true, isActive: true, isBreakGlass: true, telegramChatId: true } } } });
      if (!t || t.usedAt || t.expiresAt <= now || !t.user.isActive || t.user.isBreakGlass) return REPLY.invalid;
      await tx.telegramLinkToken.update({ where: { id: t.id }, data: { usedAt: now } });
      // One account per chat: a chat linked to another account moves here.
      const previous = await tx.user.findUnique({ where: { telegramChatId: chatId }, select: { id: true } });
      if (previous && previous.id !== t.userId) await unlinkIn(tx, previous.id, null, 'moved to another account');
      await tx.user.update({ where: { id: t.userId }, data: { telegramChatId: chatId, telegramLinkedAt: now } });
      await appendAudit(tx, {
        actorUserId: t.userId, action: 'TELEGRAM_LINKED', resource: 'user', resourceId: t.userId,
        changes: { chatId: maskChatId(chatId), replaced: t.user.telegramChatId && t.user.telegramChatId !== chatId ? maskChatId(t.user.telegramChatId) : null, issuedByAnother: t.issuedById !== t.userId }, priority: 'HIGH',
      });
      await notice(tx, t.userId, `linked:${t.id}`, 'Telegram connected', 'A Telegram chat was connected to your account. If this was not you, disconnect it in My account → Telegram and tell HR.',
        'تم ربط تيليجرام', 'تم ربط محادثة تيليجرام بحسابك. إذا لم تقم بذلك فألغِ الربط من حسابي ← تيليجرام وأبلغ الموارد البشرية.');
      return REPLY.linked;
    });
  }

  /** "/stop": unlinks whichever account this chat belongs to. */
  async function stop(chatId: string): Promise<string> {
    return db.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { telegramChatId: chatId }, select: { id: true } });
      if (!u) return REPLY.notLinked;
      await unlinkIn(tx, u.id, u.id, 'telegram /stop');
      return REPLY.unlinked;
    });
  }

  /** One incoming update (webhook, polling or the Dev Console simulator). Replies through the gateway. */
  async function handleUpdate(update: TelegramUpdate): Promise<void> {
    const m = update.message;
    const text = m?.text?.trim();
    if (!m || !text?.startsWith('/')) return; // not a command: stay quiet
    const chatId = String(m.chat.id);
    const [command, arg] = text.split(/\s+/, 2);
    const cmd = command!.toLowerCase().replace(/@.*$/, ''); // "/start@aigh_bot" in groups
    let reply: string;
    if (cmd === '/start' && arg) reply = m.chat.type === 'private' ? await redeem(chatId, arg) : REPLY.notPrivate;
    else if (cmd === '/stop') reply = await stop(chatId);
    else reply = REPLY.help(chatId);
    await telegram.send(chatId, reply);
  }

  return { status, linkSelf, linkFor, unlinkSelf, handleUpdate };
}
export type TelegramLinking = ReturnType<typeof createTelegramLinking>;
