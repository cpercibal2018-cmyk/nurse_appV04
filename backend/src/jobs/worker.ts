// Production job worker (spec §10.2: API and worker are separate processes).
// No HTTP listener; runs the scheduler under worker leases. Start with
// `npm run worker` and set JOBS_MODE=worker on the API so it does not also run jobs.

import dotenv from 'dotenv';
import { loadEnv } from '../config/env.js';
import { assertResidency } from '../config/residency.js';
import { assertRuntimeRole } from '../lib/db-role.js';
import { createPrisma } from '../lib/prisma.js';
import { describeError, logger } from '../lib/logger.js';
import { startScheduler } from './scheduler.js';
import { dispatchConfigFrom, startEmailDispatcher } from './email-dispatch.js';
import { createMailer } from '../lib/mailer.js';

dotenv.config({ quiet: true });
const env = loadEnv();
assertResidency({ region: env.DATA_RESIDENCY_REGION, allowed: env.PDPL_ALLOWED_REGIONS, isProduction: env.NODE_ENV === 'production' });

const db = createPrisma(env.DATABASE_URL);
// Spec §10.7: production runs as the data-only runtime role, never the owner.
await assertRuntimeRole(db, env.NODE_ENV === 'production');
const stopJobs = startScheduler(db);
const stopMail = startEmailDispatcher(db, createMailer(env), dispatchConfigFrom(env)); // D-47
if (env.NODE_ENV === 'production' && !env.SMTP_HOST) logger.warn('e-mail is off: SMTP_HOST is not set; notifications stay in-app (D-47)');
const stop = () => { stopJobs(); stopMail(); };

function shutdown(signal: string) {
  logger.info('worker shutting down', { signal });
  stop();
  db.$disconnect().finally(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection', describeError(e)));
