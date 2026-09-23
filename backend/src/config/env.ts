import { z } from 'zod';

// Every setting the backend reads is declared here and validated once at
// startup, so a missing or malformed value fails fast instead of surfacing as
// a confusing error deep inside a request.
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgresql:// URL'),
  // Residency values are checked by assertResidency (config/residency.ts), which
  // fails closed on empty values — so no defaults here.
  DATA_RESIDENCY_REGION: z.string().default(''),
  PDPL_ALLOWED_REGIONS: z
    .string()
    .default('')
    .transform((s) => s.split(',').map((r) => r.trim()).filter(Boolean)),
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
