// Key rotation support (B-18): every encryption key may have a "previous"
// key configured beside it (MFA_ENCRYPTION_KEY_PREVIOUS, …). While both are
// set, data sealed under either is read, and everything new is sealed under
// the current key; `npm run keys:rotate` moves the rest, after which the
// previous key is removed. AES-GCM authentication tells the two apart, so
// ciphertexts need no key label.
//
// A key's id (a 31-bit number derived from the key, never revealing it) is
// stored in the key_version columns, so the database can count rows still
// under an older key.

import crypto from 'node:crypto';

export const keyId = (key: Buffer) => crypto.createHmac('sha256', key).update('aigh-nurseapp:key-id').digest().readUInt32BE(0) & 0x7fffffff;

/** A configured previous key (base64 of 32 bytes), or null. */
export const previousKey = (value: string | undefined) => (value ? Buffer.from(value, 'base64') : null);

/** Runs `fn` with the current key, then the previous one; `rotated` says the previous one was needed. */
export function withEither<T>(current: Buffer, previous: Buffer | null, fn: (key: Buffer) => T): { value: T; rotated: boolean } {
  try {
    return { value: fn(current), rotated: false };
  } catch (e) {
    if (!previous) throw e;
    return { value: fn(previous), rotated: true };
  }
}
