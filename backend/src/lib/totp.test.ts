import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, matchTotp, newTotpSecret, otpauthUri, totp, totpStep } from './totp.js';
import { createSecretBox } from './secret-box.js';
import crypto from 'node:crypto';

// RFC 6238 Appendix B: the SHA-1 seed is the ASCII string "12345678901234567890";
// the published 8-digit values end in these 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
      [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
    ];
    for (const [t, code] of vectors) expect(totp(RFC_SECRET, t * 1000)).toBe(code);
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    expect([0, 1, 2, 9].map((c) => hotp(RFC_SECRET, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('base32 round-trips and ignores spaces, dashes, padding and case', () => {
    const bytes = crypto.randomBytes(20);
    const text = base32Encode(bytes);
    expect(text).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(text.toLowerCase().replace(/(.{4})/g, '$1 ')).equals(bytes)).toBe(true);
    expect(() => base32Decode('ABC1')).toThrow();
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('accepts one step either side of now and returns the step that matched', () => {
    const s = newTotpSecret();
    const now = 1_800_000_000_000;
    const step = totpStep(now);
    expect(matchTotp(s, totp(s, now), now)).toBe(step);
    expect(matchTotp(s, totp(s, now - 30_000), now)).toBe(step - 1);
    expect(matchTotp(s, totp(s, now + 30_000), now)).toBe(step + 1);
    expect(matchTotp(s, totp(s, now - 60_000), now)).toBeNull();
    expect(matchTotp(s, totp(s, now + 60_000), now)).toBeNull();
    expect(matchTotp(s, '12345', now)).toBeNull();
    expect(matchTotp(s, 'abcdef', now)).toBeNull();
  });

  it('builds the provisioning URI authenticator apps read', () => {
    const uri = new URL(otpauthUri('JBSWY3DPEHPK3PXP', 'hr@aigh.sa'));
    expect(uri.protocol).toBe('otpauth:');
    expect(uri.host).toBe('totp');
    expect(decodeURIComponent(uri.pathname)).toBe('/AIGH Nursing Workforce:hr@aigh.sa');
    expect(Object.fromEntries(uri.searchParams)).toEqual({ secret: 'JBSWY3DPEHPK3PXP', issuer: 'AIGH Nursing Workforce', algorithm: 'SHA1', digits: '6', period: '30' });
  });
});

describe('secret box (AES-256-GCM)', () => {
  const box = createSecretBox(crypto.randomBytes(32));
  it('seals with a fresh IV and opens again', () => {
    const a = box.seal('JBSWY3DPEHPK3PXP');
    expect(a).toMatch(/^v1:/);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(box.seal('JBSWY3DPEHPK3PXP')).not.toBe(a);
    expect(box.open(a)).toBe('JBSWY3DPEHPK3PXP');
  });
  it('rejects tampering, another key and bad keys', () => {
    const sealed = box.seal('secret');
    const parts = sealed.split(':');
    parts[2] = Buffer.from('tampered').toString('base64url');
    expect(() => box.open(parts.join(':'))).toThrow();
    expect(() => createSecretBox(crypto.randomBytes(32)).open(sealed)).toThrow();
    expect(() => createSecretBox(crypto.randomBytes(16))).toThrow(/32 bytes/);
  });
});
