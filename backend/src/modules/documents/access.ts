// Reading stored documents, and short-lived download links (spec §5.3.1, D-53).
//
// The services (contracts, credentials) decide WHO may read a document; this
// module reads it from the vault, audits the read, and turns vault failures
// into a clear error that is never a partial or wrong file:
// - an integrity failure (altered object, wrong key) → 500
//   DOCUMENT_INTEGRITY_FAILED, audited HIGH;
// - a missing object → 500 DOCUMENT_MISSING, audited HIGH.
//
// A download link is issued only after that same authorisation. It is a
// 256-bit token (only its SHA-256 stored), bound to the requesting user,
// valid LINK_SECONDS and redeemable once, by a plain browser request — so a
// PDF or image opens in a browser tab without the access token in the URL.

import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import { HttpError } from '../../lib/http-errors.js';
import { logger } from '../../lib/logger.js';
import type { Db } from '../../lib/prisma.js';
import { randomToken, sha256hex } from '../../lib/tokens.js';
import { VaultIntegrityError, type Vault } from '../../lib/vault.js';

export const LINK_SECONDS = 60;
/** inline: open in the browser (default); false: save as a file. */
export const LinkBody = z.strictObject({ inline: z.boolean().default(true) });

export interface StoredDocument {
  id: number; version: number; storageKey: string; sha256: string; mimeType: string; fileName: string;
  contractId: number | null; credentialId: number | null;
  /** Set when the file was erased with the employee's personal data (spec §8.3.3, D-55). */
  erasedAt?: Date | null;
}

const resourceOf = (d: Pick<StoredDocument, 'contractId' | 'credentialId'>) =>
  d.contractId !== null ? { resource: 'contract', resourceId: d.contractId } : { resource: 'credential', resourceId: d.credentialId! };

const erased = () => new HttpError(410, 'PERSONAL_DATA_ERASED', 'This file was erased with the employee\'s personal data (data-subject request).');

export function createDocumentAccess(db: Db, vault: Vault) {
  /** Reads a document for `actorUserId` (already authorised) and audits the download. */
  async function read(doc: StoredDocument, actorUserId: number, requestId?: string, via: 'api' | 'link' = 'api') {
    const { resource, resourceId } = resourceOf(doc);
    if (doc.erasedAt) throw erased();
    let bytes: Buffer;
    try {
      bytes = await vault.get(doc.storageKey, doc.sha256);
    } catch (e) {
      const missing = (e as NodeJS.ErrnoException).code === 'ENOENT';
      if (!missing && !(e instanceof VaultIntegrityError)) throw e;
      logger.error(missing ? 'document object missing' : 'document integrity check failed', { requestId, documentId: doc.id, error: (e as Error).message });
      await appendAudit(db, {
        actorUserId, action: missing ? 'DOCUMENT_MISSING' : 'DOCUMENT_INTEGRITY_FAILED', resource, resourceId,
        changes: { documentId: doc.id, version: doc.version }, requestId, priority: 'HIGH',
      });
      throw missing
        ? new HttpError(500, 'DOCUMENT_MISSING', 'This file is missing from storage. The incident has been recorded; tell your administrator.')
        : new HttpError(500, 'DOCUMENT_INTEGRITY_FAILED', 'This file failed its integrity check and was not served. The incident has been recorded; tell your administrator.');
    }
    await appendAudit(db, { actorUserId, action: 'DOCUMENT_DOWNLOADED', resource, resourceId, changes: { documentId: doc.id, version: doc.version, ...(via === 'link' ? { via } : {}) }, requestId });
    return { bytes, mimeType: doc.mimeType, fileName: doc.fileName };
  }

  /** A single-use link for an already authorised user. */
  async function issueLink(doc: StoredDocument, userId: number, inline: boolean, requestId?: string) {
    if (doc.erasedAt) throw erased();
    const token = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + LINK_SECONDS * 1000);
    await db.downloadLink.create({ data: { tokenHash: sha256hex(token), documentId: doc.id, userId, inline, createdAt: now, expiresAt } });
    const { resource, resourceId } = resourceOf(doc);
    await appendAudit(db, { actorUserId: userId, action: 'DOCUMENT_LINK_ISSUED', resource, resourceId, changes: { documentId: doc.id, version: doc.version, inline }, requestId });
    // The file name after the token names the tab and a save from the browser's viewer.
    return { url: `/api/v1/files/${token}/${encodeURIComponent(doc.fileName)}`, expiresAt };
  }

  const linkInvalid = () => new HttpError(404, 'LINK_INVALID', 'This link has expired or was already used. Open the document again from the application.');

  /** Redeems a link once; the user must still be active. */
  async function redeem(token: string, requestId?: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw linkInvalid();
    const now = new Date();
    const link = await db.$transaction(async (tx) => {
      const claimed = await tx.downloadLink.updateMany({ where: { tokenHash: sha256hex(token), usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (claimed.count !== 1) return null;
      return tx.downloadLink.findUnique({ where: { tokenHash: sha256hex(token) }, include: { document: true, user: { select: { isActive: true } } } });
    });
    if (!link || !link.user.isActive || link.document.scanStatus !== 'CLEAN') throw linkInvalid();
    return { ...(await read(link.document, link.userId, requestId, 'link')), inline: link.inline };
  }

  return { vault, read, issueLink, redeem };
}

export type DocumentAccess = ReturnType<typeof createDocumentAccess>;

/** Headers for serving a stored file: never sniffed, never framed, no active content. */
export function fileHeaders(file: { mimeType: string; fileName: string }, inline: boolean) {
  return {
    'Content-Type': file.mimeType,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  };
}
