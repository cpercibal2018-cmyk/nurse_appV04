import dotenv from 'dotenv';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { assertResidency } from './config/residency.js';
import { assertUploadScanner } from './lib/scanner.js';
import { assertRuntimeRole } from './lib/db-role.js';
import { createPrisma } from './lib/prisma.js';
import { describeError, logger } from './lib/logger.js';
import { startScheduler } from './jobs/scheduler.js';
import { dispatchConfigFrom, startEmailDispatcher } from './jobs/email-dispatch.js';
import { createMailer } from './lib/mailer.js';

// Quiet: dotenv's banner is not JSON and would break the one-line-JSON log format.
dotenv.config({ quiet: true });
const env = loadEnv();
// Fail closed before anything touches data (spec §8.3.6).
assertResidency({
  region: env.DATA_RESIDENCY_REGION,
  allowed: env.PDPL_ALLOWED_REGIONS,
  isProduction: env.NODE_ENV === 'production',
});
// D-10: production refuses to start without the ClamAV scanner for uploads.
assertUploadScanner(env, env.NODE_ENV === 'production');

const db = createPrisma(env.DATABASE_URL);
// Spec §10.7: production runs as the data-only runtime role, never the owner.
await assertRuntimeRole(db, env.NODE_ENV === 'production');
const app = createApp({ env, db });

// Jobs run here only in development; production runs `npm run worker` (plan: Jobs).
const stopJobs = env.JOBS_MODE === 'in-process' ? startScheduler(db) : () => undefined;
// E-mail (D-47) goes out from wherever the jobs run.
const stopMail = env.JOBS_MODE === 'in-process' ? startEmailDispatcher(db, createMailer(env), dispatchConfigFrom(env)) : () => undefined;
if (env.NODE_ENV === 'production' && !env.SMTP_HOST) logger.warn('e-mail is off: SMTP_HOST is not set; notifications stay in-app (D-47)');
if (env.NODE_ENV === 'production' && env.SMS_DRIVER === 'mock') logger.warn('SMS is simulated (SMS_DRIVER=mock): texts are kept in the Dev Console SMS inbox and not sent (D-59)');

const server = app.listen(env.PORT, () => {
  logger.info('listening', { port: env.PORT, environment: env.NODE_ENV, region: env.DATA_RESIDENCY_REGION });
});

function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopJobs();
  stopMail();
  server.close(() => {
    // Write the last buffered request-log rows (spec §9.2) before disconnecting.
    void (app.locals.requestLog as { flush: () => Promise<void> }).flush().finally(() => db.$disconnect().finally(() => process.exit(0)));
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection', describeError(e)));
