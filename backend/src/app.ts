import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { Router } from 'express';
import type { Env } from './config/env.js';
import { createPasswordService, type PasswordService } from './lib/passwords.js';
import type { Db } from './lib/prisma.js';
import { createThrottle } from './lib/throttle.js';
import { createTokenService } from './lib/tokens.js';
import { createAuthenticate } from './middleware/authenticate.js';
import { errorHandler, unknownRoute } from './middleware/errors.js';
import { requestId } from './middleware/request-id.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { createAccountService } from './modules/users/accounts.js';
import { createRoleAssignmentService } from './modules/users/role-assignments.js';
import { createUsersRouter } from './modules/users/routes.js';
import { createBaselineImportService } from './modules/administration/baseline-import.js';
import { createCatalogService } from './modules/credentials/catalog.js';
import { createRecordService } from './modules/credentials/records.js';
import { createCredentialsRouter } from './modules/credentials/routes.js';
import { createEligibilityService } from './modules/eligibility/service.js';
import { createStorage } from './lib/uploads.js';
import { createScanner, type UploadScanner } from './lib/scanner.js';
import { createWorkforceRouter } from './modules/workforce/routes.js';
import { createOrgService } from './modules/workforce/org.js';
import { createNurseService } from './modules/nurses/service.js';
import { createNursesRouter } from './modules/nurses/routes.js';
import { createContractService } from './modules/contracts/service.js';
import { createContractsRouter } from './modules/contracts/routes.js';
import { createSchedulingService } from './modules/scheduling/service.js';
import { createSchedulingRouter } from './modules/scheduling/routes.js';
import { createAttendanceService } from './modules/attendance/service.js';
import { createNotificationsRouter } from './modules/notifications/routes.js';
import { createAuditRouter } from './modules/audit/routes.js';

export interface AppDeps {
  env: Env;
  db: Db;
  /** Injectable so tests can use a cheaper bcrypt cost; defaults to env.BCRYPT_ROUNDS. */
  passwords?: PasswordService;
  /** Injectable so tests can simulate infected files and scanner outages; defaults to env.UPLOAD_SCANNER. */
  scanner?: UploadScanner;
  /** Prefix for sign-in throttle keys, so test apps sharing one database do not share counters. */
  throttleNamespace?: string;
}

const HEALTH_DB_TIMEOUT_MS = 2000;

/** Builds the Express application without starting a listener (tests use it directly). */
export function createApp({ env, db, passwords = createPasswordService(env.BCRYPT_ROUNDS), scanner = createScanner(env), throttleNamespace = '' }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1); // one hop: the hospital reverse proxy
  app.use(requestId);
  // One exact origin; credentials allowed because the refresh token travels in a cookie.
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true, exposedHeaders: ['X-Request-Id'] }));
  app.use(express.json({ limit: '1mb' }));
  // API responses carry tokens and personal data: never store them in any cache.
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use(cookieParser());

  // Liveness + database reachability. Deliberately reveals nothing else.
  app.get('/api/v1/health', async (_req, res) => {
    const database = await ping(db).then(() => 'up' as const, () => 'down' as const);
    res.status(database === 'up' ? 200 : 503).json({ status: database === 'up' ? 'ok' : 'degraded', database });
  });

  const tokens = createTokenService(env.JWT_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
  const authenticate = createAuthenticate(db, tokens, env.CORS_ORIGIN);
  const auth = createAuthService({
    db, env, tokens, passwords,
    accountThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_ACCOUNT, throttleNamespace),
    clientThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });

  app.use('/api/v1/auth', createAuthRouter(env, auth, authenticate));

  // Everything else under /api/v1 requires a signed-in caller. One protected
  // router, so authentication runs once per request; each domain module adds
  // its router here. Anonymous callers get 401 for any path, known or not.
  const api = Router();
  api.use(authenticate);
  const catalog = createCatalogService(db);
  api.use(createUsersRouter(db, createAccountService(db, passwords), createRoleAssignmentService(db), catalog, createBaselineImportService(db)));
  api.use(createWorkforceRouter(db, createOrgService(db)));
  api.use(createNursesRouter(db, createNurseService(db)));
  api.use(createSchedulingRouter(db, createSchedulingService(db), createAttendanceService(db)));
  api.use(createNotificationsRouter(db));
  api.use(createAuditRouter(db));
  api.use(createContractsRouter(db, createContractService(db, createStorage(env.STORAGE_DIR), scanner, env.UPLOAD_MAX_SIZE_BYTES), env.UPLOAD_MAX_SIZE_BYTES));
  api.use(createCredentialsRouter(
    catalog,
    createRecordService(db, createStorage(env.STORAGE_DIR), scanner, env.UPLOAD_MAX_SIZE_BYTES),
    createEligibilityService(db),
    env.UPLOAD_MAX_SIZE_BYTES,
  ));
  app.use('/api/v1', api);

  app.use('/api', unknownRoute);
  app.use(errorHandler);
  return app;
}

function ping(db: Db): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('database ping timed out')), HEALTH_DB_TIMEOUT_MS);
  });
  return Promise.race([db.$queryRaw`SELECT 1`, timeout]).finally(() => clearTimeout(timer));
}
