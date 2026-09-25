// Request-level forensic log (spec §9.2, decision D-52): "who called which
// endpoint, when, from where and what happened". The domain audit trail
// (lib/audit.ts) stays the integrity guarantee; this is the supplement that
// also covers reads, denials and failures.
//
// - One row per /api request except the liveness probe, written after the
//   response has gone: rows are buffered and inserted in batches (every
//   second, or every BATCH rows). A failed insert is logged and the batch is
//   dropped — the log never blocks or fails a request (spec §9.2).
// - No bodies and no query strings (search terms can be personal data). The
//   JSON body appears only as an HMAC-SHA256 with secrets removed, so equal
//   payloads can be matched without being stored or guessed from the hash.
// - Retention: RETENTION_DAYS, purged daily by the request-log-purge job.

import crypto from 'node:crypto';
import type { RequestHandler } from 'express';
import { logger } from './logger.js';
import type { Db } from './prisma.js';

export const RETENTION_DAYS = 365;
const FLUSH_MS = 1000;
const BATCH = 200;
/** Rows held while the database is unreachable; beyond this the oldest are dropped. */
const MAX_BUFFER = 5000;

/** Never part of the body hash, at any depth (spec §9.2 REDACTED_FIELDS, plus V04's own secrets). */
const REDACTED = new Set([
  'password', 'currentpassword', 'newpassword', 'token', 'refreshtoken', 'invitationtoken', 'authorization', 'cookie',
  'challenge', 'code', 'secret', 'recoverycodes', 'client_secret', 'clientsecret',
]);

export interface RequestLogRow {
  requestId: string;
  at: Date;
  actorUserId: number | null;
  actorRoles: string | null;
  sessionFamily: string | null;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  ipAddress: string | null;
  userAgent: string | null;
  paramsHash: string | null;
  errorCode: string | null;
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([k]) => !REDACTED.has(k.toLowerCase()))
      .map(([k, v]) => [k, redact(v)]));
  }
  return value;
}

export function createRequestLog(db: Pick<Db, 'requestLogEntry'>, hmacKey: Buffer) {
  let buffer: RequestLogRow[] = [];
  let dropped = 0;
  let timer: NodeJS.Timeout | null = null;
  let inFlight: Promise<void> = Promise.resolve();

  /** Keyed hash of a JSON body without its secrets; null when there is no body. */
  function hashBody(body: unknown): string | null {
    if (!body || typeof body !== 'object' || Buffer.isBuffer(body) || Object.keys(body).length === 0) return null;
    return crypto.createHmac('sha256', hmacKey).update(JSON.stringify(redact(body))).digest('hex');
  }

  async function write(rows: RequestLogRow[]) {
    try {
      await db.requestLogEntry.createMany({ data: rows });
    } catch (e) {
      logger.warn('request log write failed; batch dropped', { rows: rows.length, error: (e as Error).message });
    }
  }

  /** Writes everything buffered so far (awaits any write already running). */
  function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    const rows = buffer;
    buffer = [];
    if (dropped > 0) { logger.warn('request log buffer full; rows dropped', { dropped }); dropped = 0; }
    inFlight = inFlight.then(() => (rows.length ? write(rows) : undefined));
    return inFlight;
  }

  function record(row: RequestLogRow) {
    buffer.push(row);
    if (buffer.length > MAX_BUFFER) { buffer.shift(); dropped++; }
    if (buffer.length >= BATCH) void flush();
    else if (!timer) { timer = setTimeout(() => void flush(), FLUSH_MS); timer.unref(); }
  }

  /** Express middleware: records the request once its response has finished. */
  const middleware: RequestHandler = (req, res, next) => {
    if (req.path === '/v1/health') return next();
    const started = process.hrtime.bigint();
    const at = new Date();
    res.on('finish', () => {
      const auth = res.locals.auth;
      // Another system (D-63): no user; its role is API_CLIENT and its client id stands in for the session.
      const client = res.locals.client;
      record({
        requestId: String(res.locals.requestId ?? '').slice(0, 128),
        at,
        actorUserId: auth?.user.id ?? null,
        actorRoles: auth ? ([...new Set(auth.effective.map((g) => g.role))].join(',') || 'EMPLOYEE').slice(0, 100) : client ? 'API_CLIENT' : null,
        sessionFamily: (auth?.sessionFamily ?? (client ? `client:${client.clientId}` : null))?.slice(0, 64) ?? null,
        method: req.method.slice(0, 10),
        // A download-link token is a credential until used, and the file name may be personal: never logged (D-53).
        path: req.originalUrl.split('?')[0]!.replace(/^(\/api\/v1\/files\/).+/, '$1:token').slice(0, 500),
        statusCode: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        ipAddress: req.ip?.slice(0, 45) ?? null,
        userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
        paramsHash: hashBody(req.body),
        errorCode: typeof res.locals.errorCode === 'string' ? res.locals.errorCode.slice(0, 100) : null,
      });
    });
    next();
  };

  return { middleware, record, flush, hashBody };
}

export type RequestLog = ReturnType<typeof createRequestLog>;

/** The HMAC key for body hashes, derived from the JWT secret (rotating it only changes future hashes). */
export const requestLogKey = (jwtSecret: string) => Buffer.from(crypto.hkdfSync('sha256', jwtSecret, 'aigh-nurseapp', 'request-log-params', 32));
