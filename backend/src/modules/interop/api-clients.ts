// FHIR API clients (spec §14.1, D-63): another system (the HIS, payroll) calls
// the FHIR API without a person signed in — OAuth 2.0 client credentials
// (RFC 6749 §4.4) with SMART-style read scopes.
//
// - A System Admin registers a client; the secret is shown once and stored
//   only as its SHA-256 (256 random bits, so a slow hash adds nothing).
// - POST /api/v1/fhir/token exchanges the id and secret (HTTP Basic, or in the
//   form body) for a 15-minute Bearer token, signed with a key derived from
//   JWT_SECRET for this purpose only: a client token is never a user token.
// - Each FHIR request re-reads the client, so revoking it or replacing its
//   secret (secret_version) ends its tokens at once.
// - A client reads system-wide, within its scopes, and nothing but FHIR.
// - Failed attempts are throttled per address and per client id (D-46).

import crypto from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { z } from 'zod';
import { appendAudit } from '../../lib/audit.js';
import type { Db } from '../../lib/prisma.js';
import type { Throttle } from '../../lib/throttle.js';
import { constantTimeEqual, createJwt, randomToken, sha256hex, TokenError } from '../../lib/tokens.js';

export const FHIR_SCOPES = ['system/Practitioner.read', 'system/PractitionerRole.read'] as const;
export type FhirScope = (typeof FHIR_SCOPES)[number];
export const CLIENT_TOKEN_TTL_SECONDS = 900;

/** The calling system, on res.locals.client for a FHIR request made with a client token. */
export interface ClientContext {
  id: number;
  clientId: string;
  name: string;
  scopes: FhirScope[];
}

declare global {
  namespace Express {
    interface Locals {
      client?: ClientContext;
    }
  }
}

/** Separate signing key: a client token cannot pass as a user token, nor the reverse. */
export const clientTokenKey = (jwtSecret: string) => Buffer.from(crypto.hkdfSync('sha256', jwtSecret, 'aigh-nurseapp', 'fhir-client-token', 32));

export const newClientId = () => `cl_${randomToken(12)}`;
export const newClientSecret = () => `nwcs_${randomToken(32)}`;

const TokenForm = z.object({
  grant_type: z.string().optional(),
  scope: z.string().max(500).optional(),
  client_id: z.string().max(100).optional(),
  client_secret: z.string().max(200).optional(),
});

type OAuthError = 'invalid_request' | 'invalid_client' | 'unsupported_grant_type' | 'invalid_scope';

export function createClientAuth(db: Db, jwtSecret: string, throttles: { address: Throttle; client: Throttle }) {
  const jwt = createJwt(clientTokenKey(jwtSecret));
  // Compared against when the client id is unknown, so the timing does not tell.
  const DUMMY = sha256hex(randomToken(32));

  /** RFC 6749 §2.3.1: HTTP Basic with form-encoded id and secret. */
  function basic(req: Request): { id: string; secret: string } | null | 'malformed' {
    const m = /^Basic ([A-Za-z0-9+/=]+)$/.exec(req.get('authorization') ?? '');
    if (!m?.[1]) return req.get('authorization') ? 'malformed' : null;
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return 'malformed';
    try {
      return { id: decodeURIComponent(decoded.slice(0, colon).replace(/\+/g, ' ')), secret: decodeURIComponent(decoded.slice(colon + 1).replace(/\+/g, ' ')) };
    } catch { return 'malformed'; }
  }

  /** POST /api/v1/fhir/token — the OAuth 2.0 token endpoint (public: the credentials are the check). */
  const tokenEndpoint: RequestHandler = async (req, res) => {
    const deny = (status: number, error: OAuthError, description: string) => {
      res.locals.errorCode = error;
      if (status === 401 && req.get('authorization')) res.set('WWW-Authenticate', 'Basic realm="fhir"');
      res.status(status).set('Pragma', 'no-cache').json({ error, error_description: description });
    };
    const form = TokenForm.safeParse(req.body ?? {});
    if (!form.success) return deny(400, 'invalid_request', 'Send a form-encoded body');
    const fromHeader = basic(req);
    if (fromHeader === 'malformed') return deny(401, 'invalid_client', 'Malformed Basic credentials');
    if (fromHeader && (form.data.client_id || form.data.client_secret)) return deny(400, 'invalid_request', 'Send the client credentials once: in the Authorization header or in the body');
    const creds = fromHeader ?? (form.data.client_id && form.data.client_secret ? { id: form.data.client_id, secret: form.data.client_secret } : null);
    if (form.data.grant_type !== 'client_credentials') return deny(400, 'unsupported_grant_type', 'grant_type must be client_credentials');
    if (!creds) return deny(401, 'invalid_client', 'Client authentication required');

    const address = `fhir-token:ip:${req.ip ?? 'unknown'}`;
    const clientKey = `fhir-token:client:${creds.id.toLowerCase()}`;
    const wait = Math.max(await throttles.address.blockedFor(address), await throttles.client.blockedFor(clientKey));
    if (wait > 0) {
      res.locals.errorCode = 'invalid_request';
      return res.status(429).set('Retry-After', String(wait)).json({ error: 'invalid_request', error_description: `Too many failed attempts — try again in ${wait} s` });
    }

    const client = await db.apiClient.findUnique({ where: { clientId: creds.id } });
    const secretOk = constantTimeEqual(sha256hex(creds.secret), client?.secretHash ?? DUMMY);
    if (!client || !secretOk || client.revokedAt) {
      await Promise.all([throttles.address.fail(address), throttles.client.fail(clientKey)]);
      if (client) {
        await appendAudit(db, {
          actorUserId: null, action: 'API_CLIENT_AUTH_FAILED', resource: 'api_client', resourceId: client.id,
          changes: { clientId: client.clientId, reason: client.revokedAt ? 'revoked' : 'bad_secret', ip: req.ip ?? null }, requestId: res.locals.requestId,
        });
      }
      return deny(401, 'invalid_client', 'Unknown client, wrong secret or revoked client');
    }

    const allowed = client.scopes as FhirScope[];
    const asked = form.data.scope?.trim() ? [...new Set(form.data.scope.trim().split(/\s+/))] : allowed;
    const refused = asked.filter((s) => !(allowed as string[]).includes(s));
    if (refused.length > 0) return deny(400, 'invalid_scope', `Not granted to this client: ${refused.join(' ')}`);

    await throttles.client.reset(clientKey);
    await db.apiClient.update({ where: { id: client.id }, data: { lastTokenAt: new Date() } });
    const scope = asked.join(' ');
    res.set('Pragma', 'no-cache').json({
      access_token: jwt.sign({ cid: client.id, ver: client.secretVersion, scope }, CLIENT_TOKEN_TTL_SECONDS),
      token_type: 'Bearer', expires_in: CLIENT_TOKEN_TTL_SECONDS, scope,
    });
  };

  /**
   * The calling client for a Bearer token, re-read so a revocation or a new
   * secret takes effect at once. null: not a client token (or forged/expired);
   * 'ended': a genuine token whose client was revoked or whose secret changed.
   */
  async function authenticate(token: string): Promise<ClientContext | 'ended' | null> {
    let claims;
    try { claims = jwt.verify(token); } catch (e) { if (e instanceof TokenError) return null; throw e; }
    const { cid, ver, scope } = claims;
    if (!Number.isInteger(cid) || !Number.isInteger(ver) || typeof scope !== 'string') return null;
    const client = await db.apiClient.findUnique({ where: { id: cid as number } });
    if (!client || client.revokedAt || client.secretVersion !== ver) return 'ended';
    // Only scopes still granted: a narrowed client does not keep what an older token said.
    const scopes = scope.split(' ').filter((s): s is FhirScope => client.scopes.includes(s));
    return { id: client.id, clientId: client.clientId, name: client.name, scopes };
  }

  return { tokenEndpoint, authenticate };
}

export type ClientAuth = ReturnType<typeof createClientAuth>;

/** The client on this request, if a system (not a person) is calling. */
export const clientOf = (res: Response): ClientContext | undefined => res.locals.client;
