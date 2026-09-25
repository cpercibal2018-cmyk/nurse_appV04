// Encryption at rest for secrets the server must read back — the MFA (TOTP)
// seeds. AES-256-GCM with a random 96-bit IV; the stored form names its key
// version ("v1:iv:ciphertext:tag", base64url) so the key can be rotated later
// (B-18). A hash would not do: verifying a code needs the seed itself.
//
// Key: MFA_ENCRYPTION_KEY (32 random bytes, base64). Production refuses to
// start without it (env.ts). Development and tests derive one from JWT_SECRET.
// Rotation (B-18): with MFA_ENCRYPTION_KEY_PREVIOUS set, seeds sealed under
// either key open; `npm run keys:rotate` re-seals the old ones.

import crypto from 'node:crypto';
import { withEither } from './keyring.js';

export interface SecretBox {
  seal(plain: string): string;
  open(sealed: string): string;
  /** True when the value opens only with the previous key (to be re-sealed). */
  isOld(sealed: string): boolean;
}

export function createSecretBox(key: Buffer, previous: Buffer | null = null): SecretBox {
  if (key.length !== 32 || (previous && previous.length !== 32)) throw new Error('MFA_ENCRYPTION_KEY must be 32 bytes (base64 of 32 random bytes)');
  const openWith = (k: Buffer, sealed: string) => {
    const [version, iv, ct, tag] = sealed.split(':');
    if (version !== 'v1' || !iv || !ct || !tag) throw new Error('unsupported sealed secret');
    const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  };
  return {
    seal(plain) {
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return ['v1', iv, ct, cipher.getAuthTag()].map((p) => (typeof p === 'string' ? p : p.toString('base64url'))).join(':');
    },
    open(sealed) { return withEither(key, previous, (k) => openWith(k, sealed)).value; },
    isOld(sealed) { return withEither(key, previous, (k) => openWith(k, sealed)).rotated; },
  };
}

/** The configured key, or (outside production) one derived from the JWT secret. */
export function mfaKey(env: { MFA_ENCRYPTION_KEY: string; JWT_SECRET: string }): Buffer {
  if (env.MFA_ENCRYPTION_KEY) return Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64');
  return Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET, 'aigh-nurseapp', 'mfa-secret-box-dev', 32));
}
