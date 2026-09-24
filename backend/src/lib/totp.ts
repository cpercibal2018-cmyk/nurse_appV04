// Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP) for MFA, spec
// §3.5. The parameters every authenticator app supports: HMAC-SHA1, 6 digits,
// 30-second steps. A code is accepted one step either side of now (clock drift
// of up to 30 s); the caller rejects a step at or before the last one used,
// so a code works once.

import crypto from 'node:crypto';

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD_SECONDS = 30;
/** Steps accepted either side of the current one. */
export const TOTP_WINDOW = 1;
/** 160-bit secret, the RFC 4226 recommendation. */
export const TOTP_SECRET_BYTES = 20;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = BASE32.indexOf(ch);
    if (i < 0) throw new Error('invalid base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(TOTP_SECRET_BYTES));

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);

/** The HOTP value for one counter (RFC 4226 §5.3). */
export function hotp(secret: string, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** TOTP_DIGITS;
  return bin.toString().padStart(TOTP_DIGITS, '0');
}

export const totp = (secret: string, nowMs = Date.now()) => hotp(secret, totpStep(nowMs));

/**
 * The step a code belongs to, within the window around `nowMs`, or null.
 * Every candidate is compared in constant time.
 */
export function matchTotp(secret: string, code: string, nowMs = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(nowMs);
  let found: number | null = null;
  for (let s = now - TOTP_WINDOW; s <= now + TOTP_WINDOW; s++) {
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, s)), Buffer.from(code)) && found === null) found = s;
  }
  return found;
}

/** The provisioning URI an authenticator app reads from the QR code (Key Uri Format). */
export function otpauthUri(secret: string, account: string, issuer = 'AIGH Nursing Workforce') {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${q.toString()}`;
}
