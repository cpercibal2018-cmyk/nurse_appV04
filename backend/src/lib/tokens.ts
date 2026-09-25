// Access tokens: HS256 JWTs on node:crypto (ported from V03 server/src/auth.ts).
//
// Claims carry only the numeric account id, the session binding and a hash of
// the session's CSRF token (spec §3.3 "numeric account identifiers and a
// session binding"; §3.4 CSRF bound to the session). Roles are NOT embedded:
// they are read fresh from the database on every request (rule R9).

import crypto from 'node:crypto';

export interface AccessClaims {
  sub: number;
  /** Refresh-session family: revoking the family ends this token immediately. */
  sid: string;
  /** sha256(csrfToken): state-changing requests must present the matching header. */
  csrf: string;
  iat: number;
  exp: number;
}

export class TokenError extends Error {}

const b64urlJson = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');

export const sha256hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/**
 * HS256 JWT signing and verification with a pinned algorithm (never chosen by
 * the token's header: no "alg: none" or algorithm confusion) and a UTC expiry.
 * Returns the raw claims; each caller checks its own claim shapes.
 */
export function createJwt(secret: string | Buffer) {
  const hmac = (data: string) => crypto.createHmac('sha256', secret).update(data).digest('base64url');

  function sign(payload: Record<string, unknown>, ttlSeconds: number, now = Date.now()): string {
    const iat = Math.floor(now / 1000);
    const data = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson({ ...payload, iat, exp: iat + ttlSeconds })}`;
    return `${data}.${hmac(data)}`;
  }

  function verify(token: string, now = Date.now()): Record<string, unknown> & { exp: number } {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TokenError('malformed');
    const [h, p, sig] = parts as [string, string, string];

    let header: { alg?: unknown; typ?: unknown };
    try { header = JSON.parse(Buffer.from(h, 'base64url').toString()) as typeof header; } catch { throw new TokenError('bad header'); }
    if (header.alg !== 'HS256' || header.typ !== 'JWT') throw new TokenError('unsupported alg');

    if (!constantTimeEqual(hmac(`${h}.${p}`), sig)) throw new TokenError('bad signature');

    let claims: Record<string, unknown>;
    try { claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>; } catch { throw new TokenError('bad payload'); }
    if (!claims || typeof claims !== 'object' || typeof claims.exp !== 'number') throw new TokenError('bad claims');
    // UTC epoch comparison (spec §3.3: session expiry comparisons use UTC).
    if (claims.exp <= Math.floor(now / 1000)) throw new TokenError('expired');
    return claims as Record<string, unknown> & { exp: number };
  }

  return { sign, verify };
}

export function createTokenService(secret: string, ttlSeconds: number) {
  const jwt = createJwt(secret);

  const sign = (payload: Pick<AccessClaims, 'sub' | 'sid' | 'csrf'>, now = Date.now()): string => jwt.sign(payload, ttlSeconds, now);

  function verify(token: string, now = Date.now()): AccessClaims {
    const claims = jwt.verify(token, now) as Partial<AccessClaims>;
    if (!Number.isInteger(claims.sub) || typeof claims.sid !== 'string' || typeof claims.csrf !== 'string') throw new TokenError('bad claims');
    return claims as AccessClaims;
  }

  return { sign, verify, ttlSeconds };
}

export type TokenService = ReturnType<typeof createTokenService>;
