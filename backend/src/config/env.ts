import { z } from 'zod';

// Every setting the backend reads is declared here and validated once at
// startup, so a missing or malformed value fails fast instead of surfacing as
// a confusing error deep inside a request.
const int = (def: number) => z.coerce.number().int().positive().default(def);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: int(3001),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),
  // Residency values are checked by assertResidency (config/residency.ts), which
  // fails closed on empty values — so no defaults here.
  DATA_RESIDENCY_REGION: z.string().default(''),
  PDPL_ALLOWED_REGIONS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean)),

  // ── Authentication (spec §3.3, §3.4; decision D-6) ──────────────────────────
  /** HS256 signing key; spec §3.4: "minimum 256-bit random value". No default. */
  JWT_SECRET: z.string().min(32, 'must be at least 32 characters (256-bit random value)'),
  /** Access token lifetime — spec §3.4: 15 minutes. */
  ACCESS_TOKEN_TTL_SECONDS: int(900),
  /** Idle limit: a session not refreshed within this window ends — spec §3.3 "one hour of validity" (D-6). */
  SESSION_IDLE_SECONDS: int(3600),
  /** Absolute boundary regardless of activity — spec §3.3/§3.4: 24 hours (D-6). */
  SESSION_ABSOLUTE_SECONDS: int(86400),
  /** bcrypt cost — spec §3.4 BCRYPT_ROUNDS=12. */
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(15).default(12),
  // Login attempt limits: spec §3.3 requires "account/client attempt limits" but
  // gives no numbers (REQUIREMENT NOT ESTABLISHED). Defaults mirror the spec's
  // registration throttle (5 per 15 minutes) for accounts; the per-client value
  // is an implementation default. Confirm both with hospital IT.
  LOGIN_THROTTLE_WINDOW_SECONDS: int(900),
  LOGIN_THROTTLE_MAX_PER_ACCOUNT: int(5),
  LOGIN_THROTTLE_MAX_PER_CLIENT: int(20),
  /** Set when running behind the reverse proxy so req.ip is the client, not the proxy. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return parsed.data;
}
