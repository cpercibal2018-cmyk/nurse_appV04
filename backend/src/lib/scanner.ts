// Malware scanning for uploads (spec §5.3.2; decision D-10).
//
// - dev-magic-bytes (development/test): every file that passed checkUpload is
//   CLEAN. Refused in production by assertUploadScanner.
// - clamav (production): the bytes are streamed to clamd over TCP (INSTREAM)
//   before anything is written to storage. Clean → stored as CLEAN; infected →
//   never stored, rejected and audited; scanner errors → retried, then the
//   upload fails closed (503) and nothing is stored.
//
// Scanning is synchronous in the upload request (files are ≤ UPLOAD_MAX_SIZE_BYTES),
// so there is no PENDING/quarantine state to reconcile: a document row exists
// only for bytes that clamd reported clean. See docs/DEPLOYMENT.md §6.

import net from 'node:net';
import type { Env } from '../config/env.js';
import { appendAudit } from './audit.js';
import { HttpError } from './http-errors.js';
import { describeError, logger } from './logger.js';
import type { DbClient } from './prisma.js';

export type ScannerMode = Env['UPLOAD_SCANNER'];

export type ScanResult =
  | { verdict: 'CLEAN'; engine: string }
  | { verdict: 'INFECTED'; engine: string; signature: string };

export interface UploadScanner {
  readonly mode: ScannerMode;
  /** Resolves with a verdict; rejects when the scanner could not give one. */
  scan(bytes: Buffer): Promise<ScanResult>;
}

/** D-10: production must use a real scanner, and it must be addressable. */
export function assertUploadScanner(env: Pick<Env, 'UPLOAD_SCANNER' | 'CLAMAV_HOST'>, isProduction: boolean) {
  if (env.UPLOAD_SCANNER === 'clamav' && !env.CLAMAV_HOST) {
    throw new Error('UPLOAD_SCANNER=clamav requires CLAMAV_HOST (decision D-10).');
  }
  if (isProduction && env.UPLOAD_SCANNER !== 'clamav') {
    throw new Error(`UPLOAD_SCANNER=${env.UPLOAD_SCANNER} is not allowed in production (decision D-10) — set UPLOAD_SCANNER=clamav and CLAMAV_HOST.`);
  }
}

export function createDevScanner(): UploadScanner {
  return { mode: 'dev-magic-bytes', scan: async () => ({ verdict: 'CLEAN', engine: 'dev-magic-bytes' }) };
}

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs: number;
  /** Spec §5.3.2 rule 4: up to 3 attempts. */
  attempts?: number;
  /** Spec §5.3.2 rule 7: signatures older than this raise an operations alert. */
  maxSignatureAgeHours: number;
  now?: () => Date;
}

const CHUNK = 64 * 1024;

/** One clamd command over a fresh connection; resolves with the reply minus its NUL terminator. */
function clamdCommand(o: ClamdOptions, command: string, body?: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: o.host, port: o.port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, reply?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(reply!);
    };
    socket.setTimeout(o.timeoutMs, () => finish(new Error(`clamd timed out after ${o.timeoutMs} ms`)));
    socket.on('error', (e) => finish(e));
    socket.on('data', (d) => {
      chunks.push(d);
      const all = Buffer.concat(chunks);
      const nul = all.indexOf(0);
      if (nul >= 0) finish(null, all.subarray(0, nul).toString('utf8').trim());
    });
    socket.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8').replace(/\0+$/, '').trim()));
    socket.on('connect', () => {
      socket.write(`z${command}\0`);
      if (body) {
        // INSTREAM framing: <uint32 BE length><bytes> … terminated by a zero length.
        for (let i = 0; i < body.length; i += CHUNK) {
          const part = body.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(part.length);
          socket.write(len);
          socket.write(part);
        }
        socket.write(Buffer.alloc(4));
      }
    });
  });
}

/** Parses an INSTREAM reply: "stream: OK" | "stream: <Signature> FOUND" | "… ERROR". */
export function parseScanReply(reply: string): { verdict: 'CLEAN' } | { verdict: 'INFECTED'; signature: string } {
  const m = /^(?:stream|\d+: stream): (.+)$/.exec(reply);
  if (m?.[1] === 'OK') return { verdict: 'CLEAN' };
  const found = m && /^(.+) FOUND$/.exec(m[1]!);
  if (found) return { verdict: 'INFECTED', signature: found[1]! };
  throw new Error(`clamd could not scan the file: ${reply || '(empty reply)'}`);
}

export interface ClamdVersion { engine: string; signatureDate: Date | null }

/** Parses a VERSION reply: "ClamAV 1.4.3/27771/Wed Sep 23 08:24:02 2026". */
export function parseVersionReply(reply: string): ClamdVersion {
  if (!reply.startsWith('ClamAV ')) throw new Error(`unexpected clamd VERSION reply: ${reply || '(empty reply)'}`);
  const [engine, db, date] = reply.split('/');
  const signatureDate = date ? new Date(date) : null;
  return {
    engine: db ? `${engine}/${db}` : engine!,
    signatureDate: signatureDate && !Number.isNaN(signatureDate.getTime()) ? signatureDate : null,
  };
}

export function createClamdScanner(o: ClamdOptions): UploadScanner {
  const attempts = o.attempts ?? 3;
  const now = o.now ?? (() => new Date());

  async function once(bytes: Buffer): Promise<ScanResult> {
    const version = parseVersionReply(await clamdCommand(o, 'VERSION'));
    const ageHours = version.signatureDate ? (now().getTime() - version.signatureDate.getTime()) / 3_600_000 : Infinity;
    if (ageHours > o.maxSignatureAgeHours) {
      // Rule 7: alert operations; the scan itself still runs on what clamd has.
      logger.error('clamav signatures are stale', { engine: version.engine, signatureDate: version.signatureDate?.toISOString() ?? null, maxAgeHours: o.maxSignatureAgeHours });
    }
    const result = parseScanReply(await clamdCommand(o, 'INSTREAM', bytes));
    return { ...result, engine: version.engine };
  }

  return {
    mode: 'clamav',
    async scan(bytes) {
      let last: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          return await once(bytes);
        } catch (e) {
          last = e;
          logger.warn('clamav scan attempt failed', { attempt, attempts, ...describeError(e) });
        }
      }
      throw last;
    },
  };
}

export function createScanner(env: Env): UploadScanner {
  if (env.UPLOAD_SCANNER === 'dev-magic-bytes') return createDevScanner();
  return createClamdScanner({
    host: env.CLAMAV_HOST,
    port: env.CLAMAV_PORT,
    timeoutMs: env.CLAMAV_TIMEOUT_MS,
    maxSignatureAgeHours: env.CLAMAV_MAX_SIGNATURE_AGE_HOURS,
  });
}

export interface ScanContext {
  actorUserId: number;
  resource: 'credential' | 'contract';
  resourceId: number;
  fileName: string;
  sizeBytes: number;
  sha256: string;
  requestId?: string;
}

/**
 * Scans an upload that already passed checkUpload. Returns the scanner name to
 * record on a clean result; otherwise throws the client-facing error. An
 * infected file is audited (HIGH) and never stored (spec §5.3.2 rule 3).
 */
export async function scanOrReject(scanner: UploadScanner, db: DbClient, bytes: Buffer, ctx: ScanContext): Promise<string> {
  let result: ScanResult;
  try {
    result = await scanner.scan(bytes);
  } catch (e) {
    logger.error('upload scan failed; upload refused', { resource: ctx.resource, resourceId: ctx.resourceId, requestId: ctx.requestId, ...describeError(e) });
    throw new HttpError(503, 'SCANNER_UNAVAILABLE', 'The file could not be checked for malware. Nothing was saved; try again later.');
  }
  if (result.verdict === 'CLEAN') return result.engine;
  logger.error('malware detected in upload', { resource: ctx.resource, resourceId: ctx.resourceId, signature: result.signature, sha256: ctx.sha256, requestId: ctx.requestId });
  await appendAudit(db, {
    actorUserId: ctx.actorUserId, action: 'DOCUMENT_REJECTED_INFECTED', resource: ctx.resource, resourceId: ctx.resourceId,
    changes: { fileName: ctx.fileName, sizeBytes: ctx.sizeBytes, sha256: ctx.sha256, signature: result.signature, scanner: result.engine },
    requestId: ctx.requestId, priority: 'HIGH',
  });
  throw new HttpError(422, 'UPLOAD_INFECTED', 'The file was rejected by the malware scanner and was not saved');
}
