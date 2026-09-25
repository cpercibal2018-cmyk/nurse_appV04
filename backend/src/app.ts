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
import { createRequestLog, requestLogKey, type RequestLog } from './lib/request-log.js';
import { createAuthRouter } from './modules/auth/routes.js';
import { createAuthService } from './modules/auth/service.js';
import { createMfa } from './modules/auth/mfa.js';
import { createSecretBox, mfaKey } from './lib/secret-box.js';
import { createSmsGateway, type SmsGateway } from './lib/sms.js';
import { createAccountService } from './modules/users/accounts.js';
import { createRoleAssignmentService } from './modules/users/role-assignments.js';
import { createUsersRouter } from './modules/users/routes.js';
import { createInvitationService } from './modules/users/invitations.js';
import { createPasswordResetService } from './modules/users/password-reset.js';
import { createBaselineImportService } from './modules/administration/baseline-import.js';
import { createCatalogService } from './modules/credentials/catalog.js';
import { createRecordService } from './modules/credentials/records.js';
import { createCredentialsRouter } from './modules/credentials/routes.js';
import { createEligibilityService } from './modules/eligibility/service.js';
import { createEligibilityLogicRouter, type LogicRouterOptions } from './modules/eligibility/logic-routes.js';
import { previousKey } from './lib/keyring.js';
import { createLocalDiskAdapter, createVault, documentKey } from './lib/vault.js';
import { createDocumentAccess, fileHeaders } from './modules/documents/access.js';
import { fieldCryptoFromEnv } from './lib/field-crypto.js';
import { createProtection } from './modules/pdpl/protection.js';
import { createPdplRouter } from './modules/pdpl/register.js';
import { createDataSubjectRouter, createDataSubjectService } from './modules/pdpl/requests.js';
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
import { createDevConsoleRouter } from './modules/dev-console/routes.js';

export interface AppDeps {
  env: Env;
  db: Db;
  /** Injectable so tests can use a cheaper bcrypt cost; defaults to env.BCRYPT_ROUNDS. */
  passwords?: PasswordService;
  /** Injectable so tests can simulate infected files and scanner outages; defaults to env.UPLOAD_SCANNER. */
  scanner?: UploadScanner;
  /** Prefix for sign-in throttle keys, so test apps sharing one database do not share counters. */
  throttleNamespace?: string;
  /** Injectable so tests can simulate a failing gateway; defaults to env.SMS_DRIVER (D-59). */
  sms?: SmsGateway;
  /** Shadow-mode hooks for tests (the re-evaluation after a promotion runs in the background). */
  logic?: LogicRouterOptions;
  /** Injectable so tests can flush it; defaults to one writing to this database. */
  requestLog?: RequestLog;
}

const HEALTH_DB_TIMEOUT_MS = 2000;

/** Builds the Express application without starting a listener (tests use it directly). */
export function createApp({ env, db, passwords = createPasswordService(env.BCRYPT_ROUNDS), scanner = createScanner(env), throttleNamespace = '', sms = createSmsGateway(env, db), logic = {}, requestLog = createRequestLog(db, requestLogKey(env.JWT_SECRET)) }: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1); // one hop: the hospital reverse proxy
  app.locals.requestLog = requestLog;
  app.use(requestId);
  app.use('/api', requestLog.middleware); // spec §9.2: every API request, after its response
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
  const accountThrottle = createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_ACCOUNT, throttleNamespace);
  const mfa = createMfa(db, env, createSecretBox(mfaKey(env), previousKey(env.MFA_ENCRYPTION_KEY_PREVIOUS)));
  const auth = createAuthService({
    db, env, tokens, passwords, mfa, sms,
    accountThrottle,
    clientThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });

  const invitations = createInvitationService({
    db, passwords, baseUrl: env.APP_BASE_URL ?? env.CORS_ORIGIN, mailEnabled: Boolean(env.SMTP_HOST),
    throttle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });
  const passwordResets = createPasswordResetService({
    db, passwords, accountThrottle, baseUrl: env.APP_BASE_URL ?? env.CORS_ORIGIN, mailEnabled: Boolean(env.SMTP_HOST),
    clientThrottle: createThrottle(db, env.LOGIN_THROTTLE_WINDOW_SECONDS, env.LOGIN_THROTTLE_MAX_PER_CLIENT, throttleNamespace),
  });
  app.use('/api/v1/auth', createAuthRouter(env, auth, authenticate, invitations, passwordResets, mfa));

  // D-53: the document vault, and its single-use links. The link itself is the
  // credential (issued after the usual authorisation), so this route is public.
  const documents = createDocumentAccess(db, createVault(createLocalDiskAdapter(env.STORAGE_DIR), documentKey(env), previousKey(env.DOCUMENT_ENCRYPTION_KEY_PREVIOUS)));
  app.get('/api/v1/files/:token{/:name}', async (req, res) => {
    const file = await documents.redeem(String(req.params.token), res.locals.requestId);
    res.set(fileHeaders(file, file.inline)).send(file.bytes);
  });

  // Everything else under /api/v1 requires a signed-in caller. One protected
  // router, so authentication runs once per request; each domain module adds
  // its router here. Anonymous callers get 401 for any path, known or not.
  const api = Router();
  api.use(authenticate);
  const catalog = createCatalogService(db);
  const protection = createProtection(fieldCryptoFromEnv(env));
  const keyStatus = {
    masterKeyId: protection.crypto.masterKeyId, pepperId: protection.crypto.pepperId,
    previous: (['MFA_ENCRYPTION_KEY_PREVIOUS', 'DOCUMENT_ENCRYPTION_KEY_PREVIOUS', 'PDPL_FIELD_ENCRYPTION_KEY_PREVIOUS', 'PDPL_BLIND_INDEX_PEPPER_PREVIOUS'] as const).filter((k) => env[k]),
  };
  api.use(createUsersRouter(db, createAccountService(db, passwords), createRoleAssignmentService(db), catalog, createBaselineImportService(db), invitations, passwordResets, mfa));
  api.use(createWorkforceRouter(db, createOrgService(db)));
  api.use(createNursesRouter(db, createNurseService(db)));
  api.use(createSchedulingRouter(db, createSchedulingService(db), createAttendanceService(db)));
  api.use(createNotificationsRouter(db));
  api.use(createAuditRouter(db, keyStatus));
  api.use(createPdplRouter(db));
  api.use(createDevConsoleRouter(db, sms));
  api.use(createEligibilityLogicRouter(db, logic));
  api.use(createDataSubjectRouter(createDataSubjectService({ db, protection, vault: documents.vault, backupRetentionDays: env.BACKUP_RETENTION_DAYS })));
  api.use(createContractsRouter(db, createContractService(db, documents, scanner, env.UPLOAD_MAX_SIZE_BYTES), env.UPLOAD_MAX_SIZE_BYTES));
  api.use(createCredentialsRouter(
    catalog,
    createRecordService(db, documents, scanner, env.UPLOAD_MAX_SIZE_BYTES, protection),
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
