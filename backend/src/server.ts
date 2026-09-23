import dotenv from 'dotenv';
import { createApp } from './app.js';
import { loadEnv } from './config/env.js';
import { assertResidency } from './config/residency.js';
import { assertUploadScanner } from './lib/uploads.js';
import { createPrisma } from './lib/prisma.js';
import { describeError, logger } from './lib/logger.js';
import { startScheduler } from './jobs/scheduler.js';

// Quiet: dotenv's banner is not JSON and would break the one-line-JSON log format.
dotenv.config({ quiet: true });
const env = loadEnv();
// Fail closed before anything touches data (spec §8.3.6).
assertResidency({
  region: env.DATA_RESIDENCY_REGION,
  allowed: env.PDPL_ALLOWED_REGIONS,
  isProduction: env.NODE_ENV === 'production',
});
// D-10: production refuses to start without a real malware scanner for uploads.
assertUploadScanner(env.UPLOAD_SCANNER, env.NODE_ENV === 'production');

const db = createPrisma(env.DATABASE_URL);
const app = createApp({ env, db });

// Jobs run here only in development; production runs `npm run worker` (plan: Jobs).
const stopJobs = env.JOBS_MODE === 'in-process' ? startScheduler(db) : () => undefined;

const server = app.listen(env.PORT, () => {
  logger.info('listening', { port: env.PORT, environment: env.NODE_ENV, region: env.DATA_RESIDENCY_REGION });
});

function shutdown(signal: string) {
  logger.info('shutting down', { signal });
  stopJobs();
  server.close(() => {
    db.$disconnect().finally(() => process.exit(0));
  });
  // Do not hang forever on a stuck connection.
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => logger.error('unhandled rejection', describeError(e)));
