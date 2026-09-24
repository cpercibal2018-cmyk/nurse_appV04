// SMTP delivery through the hospital relay (spec §7.2; decision D-47).
//
// The mailer only sends; what to send and when lives in the e-mail dispatcher
// (jobs/email-dispatch.ts). Transport security is fixed, not configurable down:
// STARTTLS is required on the submission port (never plain text) or implicit
// TLS on 465, and the relay certificate is verified in production (env.ts).

import nodemailer from 'nodemailer';
import type { Env } from '../config/env.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
  html: string;
  /** Stable across retries, so clients do not show a repeat twice (spec §7.2). */
  messageId: string;
  /** X-Priority 1 (high) or 3 (normal). */
  urgent: boolean;
}

export interface Mailer {
  readonly enabled: boolean;
  /** Resolves when the relay accepted the message; rejects with the relay's error otherwise. */
  send(mail: OutgoingEmail): Promise<void>;
}

export const disabledMailer: Mailer = {
  enabled: false,
  send: async () => { throw new Error('e-mail is off (SMTP_HOST is not set)'); },
};

/** The domain part of an address such as "AIGH Workforce <nurseapp@aigh.sa>". */
export function senderDomain(from: string): string {
  return /@([^>\s]+)>?\s*$/.exec(from)?.[1] ?? 'localhost';
}

export function createMailer(env: Env): Mailer {
  if (!env.SMTP_HOST) return disabledMailer;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    requireTLS: !env.SMTP_SECURE, // STARTTLS or fail — never send in plain text
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    tls: { rejectUnauthorized: env.SMTP_TLS_REJECT_UNAUTHORIZED },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
  return {
    enabled: true,
    async send(mail) {
      await transport.sendMail({
        from: env.SMTP_FROM,
        replyTo: env.SMTP_REPLY_TO || undefined,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
        messageId: mail.messageId,
        priority: mail.urgent ? 'high' : 'normal',
        headers: { 'X-Mailer': 'AIGH-NurseApp/4' },
      });
    },
  };
}
