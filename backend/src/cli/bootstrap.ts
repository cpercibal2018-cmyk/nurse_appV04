// First-administrator bootstrap (database-first migration, approval P6).
//
// An empty database has no accounts, and accounts can otherwise only be created
// by a signed-in administrator. This one-time command creates, in one
// transaction:
//   - the first System Admin (hospital-wide);
//   - one hospital-wide HR Admin — a second person, so four-eyes approvals
//     (R10–R12) work from day one;
//   - optionally the break-glass account (spec §3.6, D-9).
// It refuses to run once any account exists, so it can never be used to add
// or reset an administrator later; after that, everything goes through the app.
//
// Passwords are typed at a hidden prompt (12–72 characters, spec §3.2). There is
// no default password and nothing is read from a file.
//
//   npm run build -w backend && npm run bootstrap -w backend

import 'dotenv/config';
import { createInterface } from 'node:readline';
import { z } from 'zod';
import { loadEnv } from '../config/env.js';
import { assertResidency } from '../config/residency.js';
import { appendAudit } from '../lib/audit.js';
import { createPasswordService, PasswordSchema, type PasswordService } from '../lib/passwords.js';
import { createPrisma, type Db } from '../lib/prisma.js';

const Account = z.strictObject({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  displayName: z.string().trim().min(1).max(120),
  password: PasswordSchema,
});
export const BootstrapInput = z.strictObject({
  systemAdmin: Account,
  hrAdmin: Account,
  breakGlass: Account.optional(),
}).superRefine((b, ctx) => {
  const emails = [b.systemAdmin.email, b.hrAdmin.email, b.breakGlass?.email].filter(Boolean);
  if (new Set(emails).size !== emails.length) ctx.addIssue({ code: 'custom', message: 'Each account needs its own e-mail address' });
});
export type BootstrapInput = z.infer<typeof BootstrapInput>;

const REASON = 'Initial system bootstrap — first administrators of an empty database (P6)';

export class BootstrapRefused extends Error {}

/** Creates the first accounts. Throws BootstrapRefused if any account already exists. */
export async function bootstrapAdministrators(db: Db, raw: unknown, passwords: PasswordService) {
  const input = BootstrapInput.parse(raw);
  const [saHash, hrHash, bgHash] = await Promise.all([
    passwords.hash(input.systemAdmin.password),
    passwords.hash(input.hrAdmin.password),
    input.breakGlass ? passwords.hash(input.breakGlass.password) : Promise.resolve(null),
  ]);
  return db.$transaction(async (tx) => {
    // Serialise concurrent runs, then re-check emptiness inside the lock.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('aigh_bootstrap'))`;
    if (await tx.user.count()) throw new BootstrapRefused('Accounts already exist — bootstrap runs only on an empty database. Use the application to add administrators.');

    const sa = await tx.user.create({ data: { email: input.systemAdmin.email, displayName: input.systemAdmin.displayName, passwordHash: saHash } });
    // The one self-grant the system allows (R2 cannot apply to the very first administrator).
    await tx.roleAssignment.create({ data: { userId: sa.id, role: 'SYSTEM_ADMIN', scopeType: 'SYSTEM', scopeIds: [], reason: REASON, grantedById: sa.id } });
    const hr = await tx.user.create({ data: { email: input.hrAdmin.email, displayName: input.hrAdmin.displayName, passwordHash: hrHash } });
    await tx.roleAssignment.create({ data: { userId: hr.id, role: 'HR_ADMIN', scopeType: 'SYSTEM', scopeIds: [], reason: REASON, grantedById: sa.id } });
    const bg = input.breakGlass && bgHash
      ? await tx.user.create({ data: { email: input.breakGlass.email, displayName: input.breakGlass.displayName, passwordHash: bgHash, isBreakGlass: true } })
      : null;

    await appendAudit(tx, {
      actorUserId: null, action: 'SYSTEM_BOOTSTRAPPED', resource: 'system', priority: 'HIGH',
      changes: {
        reason: REASON,
        systemAdmin: { userId: sa.id, email: sa.email, role: 'SYSTEM_ADMIN', scope: 'SYSTEM' },
        hrAdmin: { userId: hr.id, email: hr.email, role: 'HR_ADMIN', scope: 'SYSTEM' },
        breakGlass: bg ? { userId: bg.id, email: bg.email } : null,
      },
    });
    return { systemAdminId: sa.id, hrAdminId: hr.id, breakGlassId: bg?.id ?? null };
  });
}

// ── Command line ────────────────────────────────────────────────────────────

function prompter() {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  let muted = false;
  // Echo nothing while a password is typed.
  const writer = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  writer._writeToOutput = (s: string) => { if (!muted || s.includes('\n')) writer.output.write(muted ? '\n' : s); };
  const ask = (q: string, hidden = false) => new Promise<string>((resolve) => {
    muted = false;
    rl.question(q, (a) => { muted = false; resolve(a); });
    muted = hidden;
  });
  return { ask, close: () => rl.close() };
}

async function askAccount(p: ReturnType<typeof prompter>, label: string) {
  console.log(`\n${label}`);
  const email = await p.ask('  E-mail: ');
  const displayName = await p.ask('  Display name: ');
  for (;;) {
    const password = await p.ask('  Password (12–72 characters, hidden): ', true);
    const check = PasswordSchema.safeParse(password);
    if (!check.success) { console.log(`  ${check.error.issues[0]!.message}`); continue; }
    if ((await p.ask('  Repeat password: ', true)) !== password) { console.log('  The passwords differ.'); continue; }
    return { email, displayName, password };
  }
}

async function main() {
  const env = loadEnv();
  assertResidency({ region: env.DATA_RESIDENCY_REGION, allowed: env.PDPL_ALLOWED_REGIONS, isProduction: env.NODE_ENV === 'production' });
  if (!process.stdin.isTTY) throw new Error('Run bootstrap in an interactive terminal: passwords are only read from a hidden prompt.');
  const db = createPrisma(env.DATABASE_URL);
  const p = prompter();
  try {
    if (await db.user.count()) throw new BootstrapRefused('Accounts already exist — bootstrap runs only on an empty database.');
    console.log('AIGH Nursing Workforce — first administrators.\nTwo different people are needed: approvals always require a second administrator.');
    const systemAdmin = await askAccount(p, 'System Admin (hospital-wide, dormant until elevated):');
    const hrAdmin = await askAccount(p, 'HR Admin (hospital-wide):');
    const wantsBg = (await p.ask('\nCreate the break-glass account now? (y/N) ')).trim().toLowerCase() === 'y';
    const breakGlass = wantsBg ? await askAccount(p, 'Break-glass account (its password is split between two sealed envelopes):') : undefined;
    const out = await bootstrapAdministrators(db, { systemAdmin, hrAdmin, ...(breakGlass ? { breakGlass } : {}) }, createPasswordService(env.BCRYPT_ROUNDS));
    console.log(`\nDone. System Admin #${out.systemAdminId}, HR Admin #${out.hrAdminId}${out.breakGlassId ? `, break-glass #${out.breakGlassId}` : ''}. Sign in to the application to continue.`);
  } finally {
    p.close();
    await db.$disconnect();
  }
}

// Run only when executed directly (tests import the function).
if (process.argv[1] && /bootstrap\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n') : (e as Error).message);
    process.exit(1);
  });
}
