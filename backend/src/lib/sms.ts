// SMS delivery behind one interface (decisions D-48, D-59).
//
// A live Saudi SMS gateway needs a Sender ID registered with the CST, and that
// needs the hospital's Commercial Registration, which is not available yet. Until
// then SMS_DRIVER=mock: every outgoing text is saved to mock_sms_outbox and shown
// in the Dev Console (Administration → SMS inbox), and nothing leaves the server.
// Callers depend only on SmsGateway; createSmsGateway picks the driver.
//
// send() never throws: it answers true when the text was accepted (saved, for the
// mock) and false otherwise, after logging why. A lost text must not undo the
// action that caused it (a sign-in, a reminder).

import type { Env } from '../config/env.js';
import { describeError, logger } from './logger.js';
import type { DbClient } from './prisma.js';

export type SmsDriver = Env['SMS_DRIVER'];

export interface SmsGateway {
  readonly driver: SmsDriver;
  /** True when the gateway accepted the text; false (logged) when it did not. Never throws. */
  send(phone: string, message: string): Promise<boolean>;
}

/** D-35: international format, "+" and 8–15 digits (spaces, hyphens and brackets are ignored). */
export const SMS_PHONE = /^\+[1-9]\d{7,14}$/;
/** Ten concatenated segments at most; also a CHECK on mock_sms_outbox. */
export const SMS_MAX_LENGTH = 1600;

export const normalizePhone = (phone: string) => phone.replace(/[\s\-()]/g, '');

/** Logs show only the country code and the last four digits (PDPL: phone numbers are personal data). */
export const maskPhone = (phone: string) => (phone.length > 8 ? `${phone.slice(0, 4)}…${phone.slice(-4)}` : '…');

/** The text as it will be sent, or null (logged) when it cannot be. */
function checked(phone: string, message: string): { phone: string; message: string } | null {
  const p = normalizePhone(phone);
  const m = message.trim();
  if (!SMS_PHONE.test(p)) {
    logger.warn('sms not sent: the number is not in international format', { phone: maskPhone(p) });
    return null;
  }
  if (m.length === 0 || m.length > SMS_MAX_LENGTH) {
    logger.warn('sms not sent: the text is empty or too long', { phone: maskPhone(p), length: m.length });
    return null;
  }
  return { phone: p, message: m };
}

/** Saves each text to mock_sms_outbox instead of sending it. */
export class MockSmsGateway implements SmsGateway {
  readonly driver = 'mock' as const;

  constructor(private readonly db: DbClient) {}

  async send(phone: string, message: string): Promise<boolean> {
    const sms = checked(phone, message);
    if (!sms) return false;
    try {
      await this.db.mockSmsOutbox.create({ data: { recipientPhone: sms.phone, messageBody: sms.message } });
      return true;
    } catch (e) {
      logger.error('sms not saved to the mock outbox', { phone: maskPhone(sms.phone), ...describeError(e) });
      return false;
    }
  }
}

/** The live gateway (Unifonic), used once the Sender ID is registered. Not built yet: it sends nothing. */
export class UnifonicSmsGateway implements SmsGateway {
  readonly driver = 'unifonic' as const;

  constructor(private readonly settings: { appSid: string; senderId: string }) {}

  async send(phone: string, message: string): Promise<boolean> {
    const sms = checked(phone, message);
    if (!sms) return false;
    // TODO: Implement Unifonic API HTTP POST request here
    // (AppSid: this.settings.appSid, SenderID: this.settings.senderId, Recipient: sms.phone, Body: sms.message).
    logger.error('sms not sent: the Unifonic driver is not built yet (set SMS_DRIVER=mock)', { phone: maskPhone(sms.phone), senderId: this.settings.senderId });
    return false;
  }
}

/** The binding: SMS_DRIVER=mock → MockSmsGateway; anything else → UnifonicSmsGateway. */
export function createSmsGateway(env: Pick<Env, 'SMS_DRIVER' | 'UNIFONIC_APP_SID' | 'UNIFONIC_SENDER_ID'>, db: DbClient): SmsGateway {
  if (env.SMS_DRIVER === 'mock') return new MockSmsGateway(db);
  return new UnifonicSmsGateway({ appSid: env.UNIFONIC_APP_SID, senderId: env.UNIFONIC_SENDER_ID });
}
