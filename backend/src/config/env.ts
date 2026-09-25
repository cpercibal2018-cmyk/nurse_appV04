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
  // ── MFA (spec §3.5) ──────────────────────────────────────────────────────
  /**
   * Roles whose holders must use an authenticator app, comma-separated, or
   * "none". Spec §3.5 names HR Admin and System Admin; production refuses a
   * list without both. Break-glass is never asked (spec §3.6).
   */
  MFA_REQUIRED_ROLES: z
    .string()
    .default('SYSTEM_ADMIN,HR_ADMIN,SUPERVISOR')
    .transform((s) => (s.trim().toLowerCase() === 'none' ? [] : s.split(',').map((r) => r.trim()).filter(Boolean)))
    .pipe(z.array(z.enum(['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR']))),
  /** 32 random bytes, base64: encrypts the authenticator secrets at rest. Required in production. */
  MFA_ENCRYPTION_KEY: z
    .string()
    .default('')
    .refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  // Login attempt limits: spec §3.3 requires "account/client attempt limits" but
  // gives no numbers (REQUIREMENT NOT ESTABLISHED). Defaults mirror the spec's
  // registration throttle (5 per 15 minutes) for accounts; the per-client value
  // is an implementation default. Confirm both with hospital IT.
  LOGIN_THROTTLE_WINDOW_SECONDS: int(900),
  LOGIN_THROTTLE_MAX_PER_ACCOUNT: int(5),
  LOGIN_THROTTLE_MAX_PER_CLIENT: int(20),
  // ── Uploads (spec §5.1.5, §5.3.2; decision D-10) ─────────────────────────
  /** Local document storage root (never served directly). */
  STORAGE_DIR: z.string().min(1).default('./storage'),
  /** D-53: 32 random bytes, base64 — wraps each document's own encryption key. Required in production. */
  DOCUMENT_ENCRYPTION_KEY: z
    .string()
    .default('')
    .refine((k) => k === '' || Buffer.from(k, 'base64').length === 32, 'must be 32 random bytes, base64-encoded (openssl rand -base64 32)'),
  /** Spec §5.1.5: 10 MB per upload, configurable. */
  UPLOAD_MAX_SIZE_BYTES: int(10 * 1024 * 1024),
  /** D-10: dev marks files CLEAN after magic-byte checks; production requires clamav. */
  UPLOAD_SCANNER: z.enum(['dev-magic-bytes', 'clamav']).default('dev-magic-bytes'),
  /** clamd TCP endpoint (spec §5.3.2); required when UPLOAD_SCANNER=clamav. */
  CLAMAV_HOST: z.string().default(''),
  CLAMAV_PORT: int(3310),
  /** Per clamd call; spec §5.3.2: 30 s. */
  CLAMAV_TIMEOUT_MS: int(30_000),
  /** Spec §5.3.2 rule 7: older signatures raise an operations alert (error log). */
  CLAMAV_MAX_SIGNATURE_AGE_HOURS: int(48),
  // ── E-mail (spec §7.2; decision D-47: the hospital SMTP relay) ────────────
  /** Relay host; empty = e-mail off (notifications stay in-app, marked SKIPPED). */
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: int(587),
  /** false = STARTTLS on the submission port (required — never plain text); true = implicit TLS (465). */
  SMTP_SECURE: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  /** e.g. "AIGH Workforce <nurseapp@aigh.sa>" — required when SMTP_HOST is set. */
  SMTP_FROM: z.string().default(''),
  /** A monitored HR mailbox, not the service account (spec §7.2). */
  SMTP_REPLY_TO: z.string().default(''),
  /** Verify the relay's certificate; refused as false in production. */
  SMTP_TLS_REJECT_UNAUTHORIZED: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  /** Spec §7.2: up to 8 attempts, one minute apart. */
  SMTP_RETRY_MAX: z.coerce.number().int().min(1).max(20).default(8),
  SMTP_RETRY_DELAY_SECONDS: int(60),
  /** Where links in e-mails point (the app's public URL); defaults to CORS_ORIGIN. */
  APP_BASE_URL: z.string().url().optional(),
  /** Spec §3.6: people alerted by e-mail when the break-glass account signs in (the CEO and IT Director), comma-separated. */
  BREAK_GLASS_ALERT_EMAILS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((a) => a.trim()).filter(Boolean))
    .pipe(z.array(z.string().email())),
  // ── Background jobs (spec §10.2; plan "Jobs") ─────────────────────────────
  /** in-process: the API runs the scheduler (development). worker: a separate `npm run worker` runs it (production). off: nothing runs. */
  JOBS_MODE: z.enum(['in-process', 'worker', 'off']).default('in-process'),
  /** Set when running behind the reverse proxy so req.ip is the client, not the proxy. */
  TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.superRefine((e, ctx) => {
    if (e.SMTP_HOST && !e.SMTP_FROM) ctx.addIssue({ code: 'custom', path: ['SMTP_FROM'], message: 'required when SMTP_HOST is set' });
    if (e.NODE_ENV === 'production' && !e.DOCUMENT_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DOCUMENT_ENCRYPTION_KEY'], message: 'required in production (openssl rand -base64 32)' });
    }
    if (e.NODE_ENV === 'production' && e.DOCUMENT_ENCRYPTION_KEY && e.DOCUMENT_ENCRYPTION_KEY === e.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['DOCUMENT_ENCRYPTION_KEY'], message: 'must differ from MFA_ENCRYPTION_KEY' });
    }
    if (e.NODE_ENV === 'production' && !e.MFA_ENCRYPTION_KEY) {
      ctx.addIssue({ code: 'custom', path: ['MFA_ENCRYPTION_KEY'], message: 'required in production (openssl rand -base64 32)' });
    }
    if (e.NODE_ENV === 'production' && !(e.MFA_REQUIRED_ROLES.includes('SYSTEM_ADMIN') && e.MFA_REQUIRED_ROLES.includes('HR_ADMIN'))) {
      ctx.addIssue({ code: 'custom', path: ['MFA_REQUIRED_ROLES'], message: 'must include SYSTEM_ADMIN and HR_ADMIN in production (spec §3.5)' });
    }
    if (e.NODE_ENV === 'production' && !e.SMTP_TLS_REJECT_UNAUTHORIZED) {
      ctx.addIssue({ code: 'custom', path: ['SMTP_TLS_REJECT_UNAUTHORIZED'], message: 'must stay true in production (verify the relay certificate)' });
    }
  }).safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration — ${issues}`);
  }
  return parsed.data;
}
