// Document vault (spec §5.3.1, decision D-53): where uploaded evidence and
// contract copies live once they have passed the checks and the malware scan
// (lib/uploads.ts, lib/scanner.ts — nothing unscanned is ever stored, D-43).
//
// - Storage adapter: the vault writes through a small interface so the bytes
//   can move to hospital-approved private object storage later (the hosting
//   decision is open) without touching the services. Today: local disk under
//   STORAGE_DIR, sharded by the first two hex characters of the key.
// - Encryption at rest: every object is AES-256-GCM encrypted with its own
//   random data key; the data key is wrapped with DOCUMENT_ENCRYPTION_KEY (a
//   key version is recorded, so the key can be rotated by re-wrapping). The
//   object's storage key is bound in as additional data, so an object cannot
//   be passed off under another key. Objects written before the vault
//   (plaintext) are still read, and `npm run vault:encrypt` converts them.
// - Integrity: every read is checked against the SHA-256 recorded at upload;
//   a mismatch is never served (VaultIntegrityError).
// - Keys are 64 random hex characters, never derived from names, never
//   reused; an object is never overwritten (D3). The database row is written
//   after the object, so a failed transaction leaves an orphan object, which
//   the daily vault-reconcile job removes (spec §5.3.1 "reconcile orphaned
//   objects").

import crypto from 'node:crypto';
import { mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const MAGIC = Buffer.from('AIGHVLT1', 'latin1'); // 8 bytes
export const KEY_VERSION = 1;
const IV = 12;
const TAG = 16;
const WRAPPED = IV + 32 + TAG; // iv | encrypted data key | tag
const HEADER = MAGIC.length + 1 + WRAPPED + IV;

export class VaultIntegrityError extends Error {}

export interface StorageAdapter {
  readonly kind: string;
  /** Stores bytes under a new key; fails if the key exists (never overwrites). */
  create(key: string, bytes: Buffer): Promise<void>;
  read(key: string): Promise<Buffer>;
  /** The first `n` bytes (to tell encrypted objects from legacy ones cheaply). */
  readHead(key: string, n: number): Promise<Buffer>;
  remove(key: string): Promise<void>;
  /** Every stored key with its last-modified time. */
  list(): AsyncIterable<{ key: string; modifiedAt: Date }>;
}

const KEY_RE = /^[a-f0-9]{64}$/;
export const newObjectKey = () => crypto.randomBytes(32).toString('hex');

export function createLocalDiskAdapter(root: string): StorageAdapter {
  const file = (key: string) => {
    if (!KEY_RE.test(key)) throw new Error('invalid storage key');
    return path.join(root, key.slice(0, 2), key);
  };
  return {
    kind: 'local-disk',
    async create(key, bytes) {
      await mkdir(path.dirname(file(key)), { recursive: true });
      await writeFile(file(key), bytes, { flag: 'wx' });
    },
    async read(key) { return readFile(file(key)); },
    async readHead(key, n) {
      const h = await open(file(key), 'r');
      try {
        const buf = Buffer.alloc(n);
        const { bytesRead } = await h.read(buf, 0, n, 0);
        return buf.subarray(0, bytesRead);
      } finally {
        await h.close();
      }
    },
    async remove(key) { await rm(file(key), { force: true }); },
    async *list() {
      let shards: string[];
      try { shards = await readdir(root); } catch { return; }
      for (const shard of shards.filter((s) => /^[a-f0-9]{2}$/.test(s)).sort()) {
        for (const key of (await readdir(path.join(root, shard))).filter((k) => KEY_RE.test(k) && k.startsWith(shard))) {
          yield { key, modifiedAt: (await stat(path.join(root, shard, key))).mtime };
        }
      }
    },
  };
}

function gcmEncrypt(key: Buffer, plain: Buffer, aad: Buffer) {
  const iv = crypto.randomBytes(IV);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(aad);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return { iv, ct, tag: c.getAuthTag() };
}

function gcmDecrypt(key: Buffer, iv: Buffer, ct: Buffer, tag: Buffer, aad: Buffer) {
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAAD(aad);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

export const isSealed = (head: Buffer) => head.length >= MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);

export function createVault(adapter: StorageAdapter, kek: Buffer) {
  if (kek.length !== 32) throw new Error('DOCUMENT_ENCRYPTION_KEY must be 32 bytes (base64 of 32 random bytes)');
  const aadFor = (key: string) => Buffer.from(`aigh-vault:${key}`, 'latin1');

  function seal(key: string, plain: Buffer): Buffer {
    const dek = crypto.randomBytes(32);
    const wrap = gcmEncrypt(kek, dek, aadFor(key));
    const body = gcmEncrypt(dek, plain, aadFor(key));
    return Buffer.concat([MAGIC, Buffer.from([KEY_VERSION]), wrap.iv, wrap.ct, wrap.tag, body.iv, body.ct, body.tag]);
  }

  function unseal(key: string, sealed: Buffer): Buffer {
    if (sealed[MAGIC.length] !== KEY_VERSION) throw new VaultIntegrityError('unknown vault key version');
    let o = MAGIC.length + 1;
    const wIv = sealed.subarray(o, o += IV);
    const wCt = sealed.subarray(o, o += 32);
    const wTag = sealed.subarray(o, o += TAG);
    const iv = sealed.subarray(o, o += IV);
    const ct = sealed.subarray(o, sealed.length - TAG);
    const tag = sealed.subarray(sealed.length - TAG);
    try {
      const dek = gcmDecrypt(kek, wIv, wCt, wTag, aadFor(key));
      return gcmDecrypt(dek, iv, ct, tag, aadFor(key));
    } catch {
      throw new VaultIntegrityError('the object could not be decrypted (wrong key, or altered)');
    }
  }

  return {
    adapter,
    /** Encrypts and stores new bytes; returns their storage key. */
    async put(bytes: Buffer): Promise<string> {
      const key = newObjectKey();
      await adapter.create(key, seal(key, bytes));
      return key;
    },
    /** Reads, decrypts and checks the bytes against the SHA-256 recorded at upload. */
    async get(key: string, sha256: string): Promise<Buffer> {
      const raw = await adapter.read(key);
      const bytes = isSealed(raw) ? unseal(key, raw) : raw; // legacy objects are plaintext
      const actual = crypto.createHash('sha256').update(bytes).digest('hex');
      if (actual !== sha256) throw new VaultIntegrityError('the stored bytes do not match their recorded SHA-256');
      return bytes;
    },
    /** True when the object is encrypted (false for a legacy plaintext object). */
    async isEncrypted(key: string) {
      return isSealed(await adapter.readHead(key, MAGIC.length));
    },
    /** Test and migration helper: the minimum sealed size. */
    headerSize: HEADER + TAG,
  };
}

export type Vault = ReturnType<typeof createVault>;

/** The configured key, or (outside production) one derived from the JWT secret. */
export function documentKey(env: { DOCUMENT_ENCRYPTION_KEY: string; JWT_SECRET: string }): Buffer {
  if (env.DOCUMENT_ENCRYPTION_KEY) return Buffer.from(env.DOCUMENT_ENCRYPTION_KEY, 'base64');
  return Buffer.from(crypto.hkdfSync('sha256', env.JWT_SECRET, 'aigh-nurseapp', 'document-vault-dev', 32));
}
