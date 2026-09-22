# AIGH Nursing Workforce Management System
## Functional Specification, Technical Architecture and Implementation Guide

**Updated:** 18 September 2026
**Document revision:** 2.8.7 — independent-review corrections: hospital-directory totals, runtime/container alignment, session-cookie and CSRF defects, privilege-separation scope, canonical audit schema, PDPL migration (V35), idempotency lease semantics, worker leases (V49); 2.8.7a — units and bed capacity as runtime configuration (bulk API + CSV import), KSA region allowlist correction; 2.8.7b — backup/restore script corrections (closes review finding F-23); 2.8.7c — employee record shape: no Job Number format rule, First/Middle/Last with a derived Full Name, HR attributes, required Hijri contract dates, contract guards in the service layer (closes review findings F-33–F-38)
**Application baseline:** NurseApp v0.2.1 plus reviewed fixes package dated 16 September 2026
**Stack:** React / Vite / TypeScript / Ant Design, NestJS / Prisma, PostgreSQL, Redis

---

## Contents

0. Source-review correction notice
1. Purpose and scope
2. Technical architecture
   - 2.8 Frontend code-splitting and bundle optimization
   - 2.9 Hospital organizational structure
   - 2.10 Frontend globalized experience (i18n)
3. Identity, authentication and onboarding
   - 3.1.1 Position directory
   - 3.4 Browser session hardening
   - 3.6 Emergency access (break-glass)
4. Contracts
5. Credentials and evidence
   - 5.1.1 Credential categories
   - 5.1.2 Credential templates
   - 5.1.3 Template field definitions
   - 5.1.4 Credential requirements management
   - 5.1.5 Evidence upload and tracking
6. Roster eligibility and publication
   - 6.1.1 Configurable grace periods
   - 6.1.2 Emergency eligibility waivers
7. Notifications
8. Role and data-scope policy
   - 8.3 Data protection and Saudi PDPL compliance
9. Audit and persistence
   - 9.2 Request-level audit
   - 9.5 Request idempotency
10. Deployment, migrations and operations
   - 10.8 Deep observability & business health
   - 10.9 Operational survivability: shadow mode
   - 10.10 Legacy migration bridge
11. Verification and acceptance
   - 11.4 Node 20 / PostgreSQL 15 validation runbook
   - 11.5 Skipped unit test investigation and resolution
12. Implementation status
13. Roadmap and outstanding decisions
   - 13.1 Four-phase roadmap
   - 13.2 Remaining gaps and priority order
   - 13.3 Decisions required before production sizing
   - 13.4 Urgent decision action plans and deadlines
14. Enterprise integration
   - 14.1 FHIR interoperability adapter
   - 14.2 Real-time attendance integration
   - 14.3 Data portability & vendor neutrality

> **2.8.7 note:** the contents list covers top-level sections and selected subsections. Subsections 2.3–2.7, 3.2–3.3, 3.5–3.6, 5.2–5.3, 6.2–6.3, 7.2–7.5, 8.2, 8.3.1–8.3.6, 9.1–9.4, 10.2–10.10, 11.1–11.3 and 14.1–14.3 appear in the body of the document.

---

## 0. Source-review correction notice

This revision incorporates the source review and fixes applied to `NurseApp_v02_AIGH_corrected.zip`. Where this notice conflicts with a later implementation example or status label, this notice is authoritative. The original archive remains unchanged; the reviewed application is distributed separately as `NurseApp_v02_AIGH_reviewed_fixed.zip`.

### 0.1 Corrections established from the source

| Earlier specification statement or concern | Verified source position |
| :--- | :--- |
| Missing credential rules could permit scheduling | Already prevented by `nursing.eligibility_reasons`; scheduling is blocked when no applicable mandatory rules exist. |
| Notification worker advisory locking was unsafe | The supplied implementation already uses a transaction-scoped advisory lock for the scan and transactional row claiming for email delivery. |
| SMTP was only simulated | Real Nodemailer delivery, persisted attempts and retries exist. Hospital SMTP delivery still requires staging verification. |
| Request auditing was absent | Successful mutations and sensitive reads are logged by an interceptor. Denied and failed request coverage remains incomplete. |
| CI/CD was only planned | A CI workflow exists for builds, migrations and tests. Remote CI execution and production approval/rollback procedures remain to be verified. |
| Two tests were unexplained skips | They are conditional database tests. Both passed when `TEST_DATABASE_URL` was configured; CI is updated to run them. |
| SCFHS verification and credential grace periods were implemented | They are proposals, not implemented features in the reviewed archive. No assumed API contract or grace allowance was added. |

### 0.2 Fixes applied in the reviewed package

- Refresh tokens now use an HttpOnly cookie. Access tokens stay in memory, refresh tokens are not returned in JSON, and login/refresh/logout enforce an approved Origin plus a custom CSRF-protection header.
- Passwords and authentication tokens are no longer retained in browser local storage. Previously stored credentials are cleared.
- Refresh rotation supports page reload and concurrent request handling. A verified, durable per-session refresh limit replaces the shared in-memory IP limit.
- Authorization decisions, full-access matrices and accessible menus read current PostgreSQL state so a stale cache cannot preserve revoked access. Database errors deny access.
- Onboarding, invitation creation and roster publication require UUID v4 idempotency keys at the HTTP boundary. The key row is committed with the business mutation, and a processing lease prevents a crashed request from blocking the key for 24 hours (Section 9.5).
- API and scheduled work run as separate processes in the production composition.
- Runtime target alignment: the **Development/Validation Baseline** is Node 24 / PostgreSQL 17; the **Production Target** is Node 20 LTS / PostgreSQL 15. Docker, CI and package engine metadata target the production runtime.
- Frontend routes are lazy-loaded. The shared entry bundle remains 266.47 KB gzipped (target < 200 KB is currently **Unmet**).

### 0.3 Validation evidence

Local validation used Node 24.19.0 and an isolated PostgreSQL 17.11 database:

| Check | Result |
| :--- | :--- |
| Backend unit tests with the database variable configured | 68 passed, 0 skipped |
| PostgreSQL workflow and idempotency tests | 20 passed |
| Browser-client regression tests | 4 passed |
| Live HTTP checks | 24 passed while Redis was unavailable |
| Total reviewed suite | 116 tests passed (68 unit + 20 PostgreSQL workflow + 4 browser-client + 24 HTTP) |
| Ordered migrations | 26 applied successfully; repeat run detected all 26 without drift. Implementation-spec migrations V27–V48 reassigned to resolve collisions (see Section 10.1) |
| Backend build and TypeScript validation | Passed |
| Frontend TypeScript and repository build-check packaging | Passed |

These results do not establish production readiness. PostgreSQL 15 container CI, HTTPS browser acceptance, hospital SMTP, MFA, malware scanning, database privilege deployment, recovery drills, performance targets and hospital policy sign-off remain required.

### 0.4 Production recommendation

Use the reviewed package for staging verification. Do not deploy it to production until the remaining controls above have acceptance evidence. In particular, do not implement the illustrative SCFHS endpoint, response schema or recommended credential grace periods without an approved SCFHS integration agreement and hospital clinical/compliance policy.

---

## 1. Purpose and scope

### 1.1 What this document covers

This document is the single authoritative reference for the AIGH Nursing Workforce Management System. It defines:

- **Functional specification** — what the system does: business rules, workflows, data models, role permissions and operational constraints.
- **Technical architecture** — how the system is built: stack decisions, module structure, database design, security controls and deployment topology.
- **Implementation guide** — how to build and extend it: code patterns, migration scripts, configuration files and step-by-step instructions for each subsystem.

Every section follows a consistent structure: the specification states WHAT the system requires, then an implementation subsection shows HOW to build it with concrete code, schemas and configuration.

### 1.2 System overview

The AIGH Nursing Workforce Management System manages the complete lifecycle of hospital nursing staff:

- **Onboarding** — contract-first employee creation with HR-initiated invitation and secure self-registration.
- **Credentials** — document upload, versioned evidence, verification workflow and expiry tracking.
- **Eligibility** — a single canonical engine that combines employment status, contract coverage and credential validity to determine whether a nurse can be scheduled.
- **Scheduling** — draft assignment, publication with eligibility guard, coverage target monitoring.
- **Notifications** — persistent dashboard alerts and SMTP email delivery for contract/credential expiry reminders.
- **Audit** — hash-chained transactional domain events plus request-level forensic logging.

### 1.3 Architecture principles

1. **Modular monolith.** One NestJS backend codebase divided into bounded business modules with explicit exports. Modules communicate through narrow service interfaces, never through direct repository access.
2. **Single canonical eligibility.** One database function and one application service determine nurse eligibility. The frontend, worker and API all use the same implementation.
3. **Audit integrity.** Domain mutations and their audit records commit in the same database transaction. An audit failure rolls back the business operation.
4. **Separate concerns at the process level.** The HTTP API and the background worker run as separate processes from the same codebase. A worker crash does not take down the API.
5. **Defense in depth for authentication.** Refresh tokens travel in HttpOnly cookies. CSRF protection guards all state-changing requests. Access tokens are short-lived and held only in memory.
6. **PostgreSQL as the system of record.** Redis accelerates permission caching but losing it never loses data or grants unauthorized access.

### 1.4 How to read implementation status

Each section marks its content with one of these labels:

- **Implemented** — behavior present in the NurseApp v0.2.1 baseline, verified by local tests.
- **Planned** — architecture decisions made but not yet coded. These subsections state the target design.
- **Implementation specification** — detailed code patterns, schemas and step-by-step build instructions ready for a developer to execute. Not yet implemented until acceptance evidence exists (Section 11).

Sections 12–13 consolidate all outstanding work and its acceptance criteria.

---

## 2. Technical architecture

### 2.1 Technology stack

**Specification:** The system uses the following stack. All layers are mandatory.

| Layer | Technology | Responsibility |
| :--- | :--- | :--- |
| Frontend | React, Vite, TypeScript, Ant Design, React Query | Role-aware screens and validated forms |
| API | NestJS with JWT and RBAC guards | Authentication, authorization, validation and workflows |
| Persistence | PostgreSQL with Prisma ORM; ordered raw SQL migrations | Workforce records, constraints, transactions and audit |
| Cache | Redis with database fallback | Cached permissions and menus |
| Background work | NestJS scheduled jobs (separate worker process) | Date transitions, notification creation and SMTP delivery |
| Documents | Versioned database attachments | PDF/JPEG/PNG evidence and review history |

### 2.2 Deployment topology

**Specification:** The production deployment separates the API, worker, database and cache into distinct services. Only the HTTPS entry point is accessible to end users. All backend services communicate on private networks.

```mermaid
flowchart TB
    U[HR, supervisors and employees] -->|HTTPS| G[Reverse proxy / load balancer]
    G --> UI[React web application]
    G --> API[NestJS API]
    API --> PG[(PostgreSQL)]
    API --> R[(Redis cache)]
    API --> D[Private document storage]
    W[Background worker] --> PG
    W --> D
    W --> S[Hospital SMTP relay]
    API -. Optional hospital SSO .-> IDP[Identity provider]
    API --> O[Central logs and metrics]
    W --> O
    PG --> B[Encrypted backups]
    D --> B
```

**Implementation — Docker Compose (production):**

```yaml
# docker-compose.production.yml
services:
  # Only the HTTPS entry point is reachable from the hospital network.
  # The API port is never published to the host (see `expose` below).
  proxy:
    image: nginx:1.27-alpine
    ports: ["443:443", "80:80"]
    volumes:
      - ./deploy/nginx.conf:/etc/nginx/nginx.conf:ro
      - ./deploy/tls:/etc/nginx/tls:ro
    depends_on:
      api: { condition: service_healthy }
    restart: unless-stopped

  api:
    build: .
    command: ["node", "dist/main.js"]
    expose: ["3000"]                      # private network only
    environment:
      - NODE_ENV=production
      - ENABLE_SCHEDULER=false
      - APP_ORIGIN=${APP_ORIGIN}
      - DATABASE_URL=${DATABASE_URL}      # nurseapp_runtime (Section 10.7)
      - REDIS_URL=${REDIS_URL}
    depends_on:
      db:    { condition: service_healthy }
      redis: { condition: service_healthy }
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 30s
    restart: unless-stopped

  worker:
    build: .
    command: ["node", "dist/main-worker.js"]
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - SMTP_HOST=${SMTP_HOST}
      - SMTP_PORT=${SMTP_PORT}
      - SMTP_USER=${SMTP_USER}
      - SMTP_PASS=${SMTP_PASS}
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped

  db:
    image: postgres:15
    volumes: ["pgdata:/var/lib/postgresql/data"]
    environment:
      - POSTGRES_PASSWORD=${POSTGRES_PASSWORD}   # deployment secret store
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
```

**Implementation — Dockerfile (production):**

```dockerfile
# Dockerfile
# Runtime target: Node 20 LTS (Sections 0.2 and 11.4). Keep this tag in step
# with the `engines` field in package.json and the CI runner image.

FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
# --ignore-scripts suppresses postinstall hooks, so Prisma's client generation
# must be run explicitly below.
RUN npm ci --ignore-scripts
COPY . .
RUN npx prisma generate && npm run build

# Production dependencies only — keeps build tooling out of the runtime image.
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
# The generated Prisma client lives inside node_modules and is not produced by
# the --omit=dev --ignore-scripts install above; copy it from the build stage.
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma ./prisma
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
```

The API process runs `main.ts` (HTTP listener, controllers, guards — no schedulers). The worker process runs `main-worker.ts` (cron jobs, SMTP delivery — no HTTP listener). Both share the same codebase, Prisma client and PostgreSQL database.

**API versioning strategy:** To prevent system-wide crashes during schema updates (e.g., moving from BLOBs to S3 or adding PII blind indexes), the system implements strict versioned routing.

- **Current route** — `/api/v1/...`
- **Migration path** — when a breaking change is introduced, the API maintains `/api/v1` (compatibility layer) and `/api/v2` (new logic) simultaneously.
- **Sunset policy** — the old version is deprecated after 90 days or once all internal clients (frontend/worker) have migrated.

### 2.3 Application modules

**Specification:** The backend is organized into nine bounded modules. Each module owns one business domain and exposes only a public service interface.

| Module | Responsibility | Public interface |
| :--- | :--- | :--- |
| Identity | Accounts, roles, data scopes, invitations, sessions | Who can perform an action on a particular record |
| Workforce | Employees, Job Numbers, departments, nursing units, bed capacity, positions | Employee identity, organizational placement and hospital structure |
| Contracts | Employment periods, approval, renewal, termination | Employment coverage on a specified date |
| Credentials | Requirements, evidence versions, review, validity | Compliance status on a specified date |
| Eligibility | Combines employment + compliance + assignment conditions | Eligible/ineligible with specific reasons |
| Scheduling | Draft assignments, publication, coverage targets | Calls eligibility before saving or publishing |
| Notifications | Recipient events, email delivery, retries, acknowledgement | Runs asynchronously; does not change employment rules |
| Reporting | Scoped dashboards and coverage reports | Reads operational data; cannot mutate source records |
| Audit | Transactional domain events and access history | Records actor, action, resource and sanitized changes |

**Implementation — folder structure:**

```
src/modules/
├── identity/
│   ├── identity.module.ts
│   ├── identity.service.ts          # ← PUBLIC interface (exported)
│   ├── controllers/
│   ├── repositories/
│   └── guards/
├── workforce/
│   ├── workforce.module.ts
│   ├── workforce.service.ts         # ← PUBLIC interface
│   ├── controllers/
│   └── repositories/
├── contracts/
│   ├── contracts.module.ts
│   ├── contracts.service.ts         # ← PUBLIC interface
│   ├── controllers/
│   └── repositories/
├── credentials/
│   ├── credentials.module.ts
│   ├── credentials.service.ts       # ← PUBLIC interface
│   ├── controllers/
│   └── repositories/
├── eligibility/
│   ├── eligibility.module.ts
│   ├── eligibility.service.ts       # ← PUBLIC interface (wraps DB function)
│   └── eligibility.guard.ts
├── scheduling/
│   ├── scheduling.module.ts
│   ├── scheduling.service.ts
│   ├── controllers/
│   └── repositories/
├── notifications/
│   ├── notifications.module.ts
│   ├── notifications.service.ts
│   ├── notification.worker.ts
│   └── templates/
├── reporting/
│   ├── reporting.module.ts
│   └── reporting.service.ts
└── audit/
    ├── audit.module.ts
    ├── audit.service.ts
    └── audit.interceptor.ts
```

### 2.4 Module boundary enforcement

**Specification:** Each module exports only its public service. Internal repositories and helpers are never exported. Cross-module access is permitted only through the exported service interface. Direct imports of another module's repositories, entities or internal helpers are forbidden.

**Implementation — NestJS module registration:**

```typescript
// src/modules/contracts/contracts.module.ts
@Module({
  imports: [AuditModule],
  controllers: [ContractsController],
  providers: [
    ContractsService,
    ContractsRepository,        // internal — NOT exported
  ],
  exports: [ContractsService],  // ← ONLY the public interface
})
export class ContractsModule {}
```

**Implementation — public service interface example:**

```typescript
// src/modules/contracts/contracts.service.ts
@Injectable()
export class ContractsService {
  // Public contract — other modules call ONLY these
  async hasActiveCoverage(employeeId: number, date: Date): Promise<boolean> { ... }
  async getContractForDate(employeeId: number, date: Date): Promise<ContractView | null> { ... }
  async createDraftContract(dto: CreateContractDto, actorId: number): Promise<Contract> { ... }
  async approveContract(contractId: number, actorId: number): Promise<Contract> { ... }
  // Repository methods like findByPrismaQuery() stay INTERNAL
}
```

### 2.5 Module dependency map

```
Eligibility ──depends on──► Contracts.service
     │                          │
     ├──depends on──► Credentials.service
     │
     └──depends on──► Workforce.service

Scheduling ──depends on──► Eligibility.service  (calls before save/publish)

Notifications ──depends on──► Contracts.service   (reads expiry dates)
      │
      └──depends on──► Credentials.service (reads expiry dates)

Credentials ──depends on──► ScfhsIntegration.service (verification, nightly sync)
      │
      ├──depends on──► GracePeriod.service  (grace activation/completion/expiry)
      │
      └──depends on──► Quarantine.service   (upload scanning pipeline)

Eligibility ──depends on──► GracePeriod.service  (grace-aware eligibility checks)

Notifications ──depends on──► PushDelivery.service (mobile push delivery)

Reporting ───read-only───► All modules via their .service (never writes)

Audit ◄──depended on by──── All modules (interceptor + service)
```

### 2.6 Module extraction steps

**Implementation — gradual migration, no API changes:**

1. Create the folder structure for all nine modules. Leave the existing `aigh` module in place.
2. Extract `audit` first (no outbound dependencies). Register `AuditModule`, export its service, update importers.
3. Extract `workforce` (employee master) — move employee repository and service.
4. Extract `contracts`, `credentials`, `eligibility` in that order — eligibility depends on the first two.
5. Extract `scheduling`, `notifications`, `reporting`, `identity`.
6. Delete the empty `aigh` module when nothing remains in it.
7. Add a lint rule to enforce boundaries.

Public API routes (`/api/v1/...`) do not change. Controllers move to their new module folders but keep the same route paths. The database schema stays untouched. Run the full test suite after each module extraction.

### 2.7 Lint enforcement for module boundaries

**Implementation — eslint-plugin-boundaries:**

```javascript
// .eslintrc.js
'boundaries/element-types': ['error', {
  default: { allow: [] },
  rules: [{
    from: 'modules/*',
    allow: [
      ['modules/*', { import: '*.service' }],
      ['modules/*', { import: '*.module' }],
    ],
    disallow: [
      ['modules/*', { import: 'repositories/*' }],
      ['modules/*', { import: 'entities/*' }],
    ],
  }],
}]
```

### 2.8 Frontend code-splitting and bundle optimization

**Specification:** The frontend applies route-based code-splitting via `React.lazy` and Vite's built-in chunking to reduce the initial bundle size below 200 KB (gzipped). Each top-level route loads its own chunk on demand, and shared libraries are extracted into long-lived vendor chunks. Preloading hints ensure that navigation between modules remains instantaneous for users on hospital workstations.

**Current problem:** The Vite production build emits a single JavaScript bundle that exceeds the recommended size threshold, producing a build warning. Hospital workstations often run older hardware with constrained bandwidth, making large initial loads noticeably slow.

**Splitting strategy:**

```mermaid
flowchart TB
    subgraph "Entry Point (~15 KB gz)"
        APP[App Shell\nRouter + Layout + AuthGuard]
    end

    subgraph "Route Chunks (lazy-loaded)"
        DASH[Dashboard chunk]
        WF[Workforce chunk\nOnboarding + Employees]
        CON[Contracts chunk]
        CRED[Credentials chunk\nEvidence + SCFHS status]
        SCHED[Scheduling chunk\nRoster + Publication]
        ADMIN[Admin chunk\nUsers + Roles + Config]
        RPT[Reports chunk]
    end

    subgraph "Vendor Chunks (long-cached)"
        ANTD[antd + @ant-design/icons]
        REACT[react + react-dom]
        UTIL[dayjs + axios + misc]
    end

    APP -->|"React.lazy"| DASH
    APP -->|"React.lazy"| WF
    APP -->|"React.lazy"| CON
    APP -->|"React.lazy"| CRED
    APP -->|"React.lazy"| SCHED
    APP -->|"React.lazy"| ADMIN
    APP -->|"React.lazy"| RPT

    DASH --> ANTD
    WF --> ANTD
    SCHED --> ANTD
```

**Implementation — lazy route definitions:**

```typescript
// src/routes.tsx
import { lazy, Suspense } from 'react';
import { RouteObject } from 'react-router-dom';
import { PageSkeleton } from './components/PageSkeleton';

// Lazy-loaded route modules — each produces a separate chunk
const Dashboard        = lazy(() => import('./modules/dashboard/DashboardPage'));
const WorkforceModule  = lazy(() => import('./modules/workforce/WorkforceRoutes'));
const ContractsModule  = lazy(() => import('./modules/contracts/ContractsRoutes'));
const CredentialsModule = lazy(() => import('./modules/credentials/CredentialsRoutes'));
const SchedulingModule = lazy(() => import('./modules/scheduling/SchedulingRoutes'));
const AdminModule      = lazy(() => import('./modules/admin/AdminRoutes'));
const ReportsModule    = lazy(() => import('./modules/reports/ReportsRoutes'));

// Wrap each lazy route in a Suspense boundary with a consistent skeleton
function lazyRoute(Component: React.LazyExoticComponent<any>): RouteObject['element'] {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Component />
    </Suspense>
  );
}

export const appRoutes: RouteObject[] = [
  { path: '/',             element: lazyRoute(Dashboard) },
  { path: '/workforce/*',  element: lazyRoute(WorkforceModule) },
  { path: '/contracts/*',  element: lazyRoute(ContractsModule) },
  { path: '/credentials/*', element: lazyRoute(CredentialsModule) },
  { path: '/scheduling/*', element: lazyRoute(SchedulingModule) },
  { path: '/admin/*',      element: lazyRoute(AdminModule) },
  { path: '/reports/*',    element: lazyRoute(ReportsModule) },
];
```

**Implementation — Vite chunk strategy:**

```typescript
// vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2020',
    // Coarse raw-kB warning only. Vite measures raw bytes, not gzip, so this
    // number must not be raised to silence the entry-bundle warning — the real
    // gate is the gzipped budget check implemented in the Rules below.
    chunkSizeWarningLimit: 250,  // KB (raw) — do not raise further
    rollupOptions: {
      output: {
        manualChunks: {
          // Vendor chunks — change infrequently, cached long-term
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-antd': ['antd', '@ant-design/icons'],
          'vendor-utils': ['dayjs', 'axios', '@tanstack/react-query'],
        },
      },
    },
  },
});
```

**Implementation — route preloading on hover/focus:**

```typescript
// src/components/NavLink.tsx
// Preloads the target route chunk when the user hovers or focuses a nav link,
// so the chunk is already cached by the time they click.

import { Link, LinkProps } from 'react-router-dom';
import { useCallback } from 'react';

// Map route prefixes to their chunk import functions
const chunkLoaders: Record<string, () => Promise<any>> = {
  '/workforce':   () => import('../modules/workforce/WorkforceRoutes'),
  '/contracts':   () => import('../modules/contracts/ContractsRoutes'),
  '/credentials': () => import('../modules/credentials/CredentialsRoutes'),
  '/scheduling':  () => import('../modules/scheduling/SchedulingRoutes'),
  '/admin':       () => import('../modules/admin/AdminRoutes'),
  '/reports':     () => import('../modules/reports/ReportsRoutes'),
};

export function NavLink({ to, children, ...rest }: LinkProps) {
  const preload = useCallback(() => {
    const path = typeof to === 'string' ? to : to.pathname ?? '';
    const loader = Object.entries(chunkLoaders).find(
      ([prefix]) => path.startsWith(prefix),
    );
    if (loader) loader[1]();  // Fire and forget — browser caches the module
  }, [to]);

  return (
    <Link
      to={to}
      onMouseEnter={preload}
      onFocus={preload}
      {...rest}
    >
      {children}
    </Link>
  );
}
```

**Performance targets:**

| Metric | Target | Status | Measurement |
| :--- | :--- | :--- | :--- |
| Initial bundle (App Shell + vendor-react) | < 200 KB gzipped | **Unmet** (266.47 KB) | `vite build` output; `wc -c dist/assets/*.js.gz` |
| Largest route chunk | < 150 KB gzipped | Met | `vite build` output |
| Vite build warning | None | Unmet | `chunkSizeWarningLimit` exceeded |
| First Contentful Paint (hospital workstation) | < 2 seconds | | Lighthouse on representative hardware |
| Route navigation (cached chunk) | < 100 ms | | React Profiler; no visible loading skeleton |
| Route navigation (uncached chunk) | < 500 ms | | Network throttled to hospital LAN speed |

**Rules:**

1. Every top-level route uses `React.lazy` with a dynamic `import()`. Direct (static) imports of route-level page components into the main bundle are not permitted.
2. The `Suspense` fallback shows a consistent `PageSkeleton` component (Ant Design `Skeleton` matching the page layout) rather than a blank screen or spinner.
3. Vendor chunks (`vendor-react`, `vendor-antd`, `vendor-utils`) are defined in `manualChunks` and contain only third-party libraries that change infrequently. Application code must never appear in vendor chunks.
4. Navigation links in the sidebar and header use the `NavLink` component (or equivalent) that preloads the target chunk on `mouseenter` / `focus`, hiding the lazy-load latency from users.
5. Ant Design's default icon bundle is large. Import icons individually (`import { UserOutlined } from '@ant-design/icons'`) — never import the entire icon set.
6. `dayjs` locale files are excluded by default. Import only the locales needed (`import 'dayjs/locale/ar'` for Arabic if required).
7. After each dependency upgrade, run the bundle budget check. CI fails when the gzipped entry bundle exceeds 200 KB or any single chunk exceeds 150 KB. Vite's own `chunkSizeWarningLimit` is a raw-kB warning and must never be raised to silence it.

**Implementation — bundle budget check:**

```javascript
// scripts/check-bundle-size.mjs — fails the build when the gzipped budget is exceeded.
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const ASSETS = 'dist/assets';
const ENTRY_BUDGET_KB = 200;   // app shell + vendor-react, gzipped (Section 2.8)
const CHUNK_BUDGET_KB = 150;   // any single chunk, gzipped

const gzKb = (f) => gzipSync(readFileSync(`${ASSETS}/${f}`)).length / 1024;
let entryKb = 0;
let failed = false;

for (const f of readdirSync(ASSETS).filter((f) => f.endsWith('.js'))) {
  const size = gzKb(f);
  if (f.startsWith('index-') || f.startsWith('vendor-react')) entryKb += size;
  if (size > CHUNK_BUDGET_KB) {
    console.error(`FAIL ${f}: ${size.toFixed(2)} KB gz > ${CHUNK_BUDGET_KB} KB`);
    failed = true;
  }
}
if (entryKb > ENTRY_BUDGET_KB) {
  console.error(`FAIL entry bundle: ${entryKb.toFixed(2)} KB gz > ${ENTRY_BUDGET_KB} KB`);
  failed = true;
}
if (failed) process.exit(1);
console.log(`Bundle budget OK — entry ${entryKb.toFixed(2)} KB gz`);
```

Wire it into CI immediately after the frontend build: `node scripts/check-bundle-size.mjs`.

**Acceptance criteria for frontend code-splitting:**

| Criterion | Required evidence |
| :--- | :--- |
| No build warning | `vite build` completes with zero chunk-size warnings |
| Route isolation | Navigating to `/workforce` loads only the workforce chunk; other route chunks are not fetched (verified via Network tab) |
| Vendor separation | `vendor-react`, `vendor-antd` and `vendor-utils` appear as separate chunks in the build output |
| Preloading works | Hovering a sidebar link triggers a chunk prefetch visible in Network tab; subsequent click shows no loading skeleton |
| Skeleton fallback | On a throttled connection, navigating to an uncached route shows `PageSkeleton` (not a blank screen) until the chunk loads |
| Initial load target | App Shell + vendor-react chunk total < 200 KB gzipped |
| CI guard | A build step fails if any individual chunk exceeds 150 KB gzipped |

### 2.9 Hospital organizational structure

**Specification:** The system models the hospital's organizational hierarchy as a three-level structure: **departments** contain **nursing units**, and nursing units track **bed capacity**. This structure drives employee assignment, credential requirement scoping, shift scheduling, coverage monitoring and administrative reporting.

**Data model:**

```
Department (service line)
  └── Nursing Unit (operational unit)
        └── Bed Capacity (tracked per unit)
```

- A **department** is an organizational grouping of related nursing units under a common service line — for example "Critical Care & Intensive Services" groups ICU Main, ICU Extension, NICU, PICU, CCU, Burn ICU, ASU and HDU.
- A **nursing unit** is the operational entity where employees are assigned, credential requirements are scoped, shifts are scheduled and coverage targets are measured. Each unit has a short code, a descriptive name and belongs to exactly one department.
- **Bed capacity** is an integer count tracked per nursing unit. It represents the physical bed allocation that informs staffing targets and coverage calculations. Administrative and coordination units have zero beds. Bed capacity can be adjusted by authorized users to reflect ward reconfigurations, surge capacity or seasonal changes.

**Department catalog (seeded from hospital directory):**

| Department Code | Department Name | Units |
| :--- | :--- | :--- |
| EMAC | Emergency & Acute Care | ER_MAIN, ER_MC, UCC, CDU, ER_COORD, ED_NAV, ED_ADMIN |
| SURG | Surgical & Perioperative Services | OR, OR_COORD, PACU, DAY_SURG, PLASTER |
| CRIT | Critical Care & Intensive Services | ICU_MAIN, ICU_EXT, NICU, PICU, CCU, BURN_ICU, ASU, HDU |
| GNSP | General & Specialty Services | INP_WARDS, AKU, REHAB, PEDIA, LND, OBGYNE, NBS, OPD_DENTAL, JAIL, RRT, ECHO_EEG, ENDO, RADIOLOGY, BLOOD_BANK, LAB, DIABETIC, DISCHARGE |
| CORP | Administrative & Corporate Services | NURS_ADMIN, HR, IC, PAT_EXP, PAT_AFFAIRS, ACADEMIC, BIZ_CENTER, IDARA, STORE, HOME_CARE |

**Nursing unit catalog (seeded from hospital directory):**

| Unit Code | Unit Name | Department | Beds | Description |
| :--- | :--- | :--- | :---: | :--- |
| ER_MAIN | ER Main / Adult | EMAC | 39 | Primary triage and emergency care for adults |
| ER_MC | ER M&C | EMAC | 32 | Emergency care for Mothers and Children |
| UCC | Urgent Care Center | EMAC | 15 | Urgent care for non-life-threatening needs |
| CDU | Clinical Decision Unit | EMAC | 32 | Observation unit for clinical decisions |
| ER_COORD | ER Coordinator | EMAC | 0 | Patient flow and resource management |
| ED_NAV | ED Navigation | EMAC | 8 | Patient routing and intake |
| ED_ADMIN | ED Admin | EMAC | 7 | Clerical support for Emergency Department |
| OR | Operating Room | SURG | 12 | Sterile surgical suites |
| OR_COORD | OR Coordinator | SURG | 0 | Surgical scheduling and theater flow |
| PACU | Recovery / PACU | SURG | 8 | Post-Anesthesia Care Unit |
| DAY_SURG | Day Surgery | SURG | 9 | Same-day surgical procedures |
| PLASTER | Plaster Unit | SURG | 9 | Orthopedic casting and splinting |
| ICU_MAIN | ICU Main | CRIT | 79 | Intensive care for critically ill adults |
| ICU_EXT | ICU Extension | CRIT | 28 | Overflow critical care capacity |
| NICU | Neonatal Intensive Care | CRIT | 15 | Neonatal intensive care |
| PICU | Pediatric Intensive Care | CRIT | 15 | Pediatric intensive care |
| CCU | Coronary Care Unit | CRIT | 10 | Cardiac intensive care |
| BURN_ICU | Burn ICU | CRIT | 6 | Specialized care for burn trauma |
| ASU | Acute Stabilization Unit | CRIT | 6 | Acute stabilization |
| HDU | High Dependency Unit | CRIT | 6 | Step-down unit |
| INP_WARDS | Inpatient Wards | GNSP | 98 | General and specialized acute care (3A–5B) |
| AKU | Allergy and Kidney Unit | GNSP | 14 | Allergy and kidney unit |
| REHAB | Rehabilitation | GNSP | 17 | Rehabilitation and physical therapy |
| PEDIA | Pediatric Inpatient | GNSP | 15 | Inpatient pediatric care |
| LND | Labor and Delivery | GNSP | 15 | Labor and delivery |
| OBGYNE | Obstetrics & Gynecology | GNSP | 17 | Obstetrics and gynecology |
| NBS | Newborn Screening | GNSP | 3 | Newborn screening unit |
| OPD_DENTAL | OPD / Dental | GNSP | 23 | Outpatient clinics |
| JAIL | Jail Ward | GNSP | 12 | Secured unit for incarcerated patients |
| RRT | Respiratory Rehab | GNSP | 5 | Respiratory rehabilitation therapy |
| ECHO_EEG | ECHO / EEG | GNSP | 2 | Diagnostic electrical testing |
| ENDO | Endoscopy | GNSP | 5 | GI visual diagnostics |
| RADIOLOGY | Radiology | GNSP | 6 | Imaging services (X-Ray/CT/MRI) |
| BLOOD_BANK | Blood Bank | GNSP | 2 | Blood storage and donation |
| LAB | Laboratory | GNSP | 0 | Clinical pathology diagnostics |
| DIABETIC | Diabetic Center | GNSP | 10 | Specialized diabetes management |
| DISCHARGE | Discharge Lounge | GNSP | 2 | Transition area for departing patients |
| NURS_ADMIN | Nursing Admin | CORP | 0 | Nursing staff management |
| HR | Human Resources | CORP | 0 | Human resources and payroll |
| IC | Infection Control | CORP | 0 | Infection control |
| PAT_EXP | Patient Experience | CORP | 0 | Patient satisfaction and feedback |
| PAT_AFFAIRS | Patient Affairs | CORP | 0 | Admissions and patient rights |
| ACADEMIC | Academic Affairs | CORP | 0 | Medical education and training |
| BIZ_CENTER | Business Center | CORP | 0 | Finance and billing |
| IDARA | Idara | CORP | 0 | General management office |
| STORE | Store | CORP | 0 | Supply chain and inventory |
| HOME_CARE | Home Care | CORP | 0 | Coordination of home-based medical care |

**Summary (seeded baseline):** 5 departments, 47 nursing units, total bed capacity: 582 — by department: EMAC 133, SURG 38, CRIT 165, GNSP 246, CORP 0.

This is the **initial seed** taken from the Hospital Master Unit Directory. It is a starting point, not a fixed constraint: units and bed capacity are fully editable in the running system. HR Admin and System Admin can add or edit units, adjust a single unit's bed capacity, or apply a **bulk capacity update / CSV import** to enter a required bed plan in one action (see "Entering the required numbers" below). Every change — single or bulk — is recorded in `bed_capacity_log` with actor, reason, previous value and new value.

**Authority after go-live:** the directory is the reference for the initial seed only. Once live, the system is the operational source of truth for unit structure and bed capacity; reports, coverage calculations and staffing-ratio views always read current capacity. Entering the required numbers is a configuration task, not a release, and never requires a migration.

**CRUD operations:**

All three entities (departments, nursing units, bed capacity) support full Add / Edit / Delete operations by authorized users (HR Admin, System Admin). Position codes (Section 3.1.1) also support Add / Edit / Delete by the same authorized roles.

**Department operations:**

- **Add** — create a new department with a unique code and name. Code format: uppercase alphanumeric, 2–10 characters.
- **Edit** — rename a department or change its description. Changing a department code is not permitted once units reference it.
- **Delete** — remove a department only when it has no active nursing units. Units must be reassigned or deleted first. Deletion is a soft delete (`deleted_at` timestamp) — the department remains in historical records.

**Nursing unit operations:**

- **Add** — create a new unit with a unique code, name, description, parent department and initial bed capacity. Code format: uppercase alphanumeric with underscores, 2–20 characters.
- **Edit** — rename a unit, change its description, update its department assignment or adjust its bed capacity. Changing a unit code is not permitted once employees, credential requirements or shift assignments reference it.
- **Delete** — remove a unit only when no active employees are assigned to it, no future shift assignments reference it and no active credential requirements target it. References must be reassigned first. Deletion is a soft delete.

**Bed capacity operations:**

- **Add** — set the bed capacity for a unit. Stored as an integer on the nursing unit record. Zero is valid (administrative and coordination units).
- **Edit** — adjust bed capacity to reflect ward reconfigurations, surge capacity or seasonal changes. Each change is recorded with a timestamp, the previous value, the new value and the actor, in a `bed_capacity_log` audit table. Bulk edits follow the same rule: every changed unit produces its own log row, so a full re-baseline is fully traceable.
- **Delete** — reset bed capacity to zero (units cannot exist without a capacity value; "no beds" = 0). The change is logged.

**Position operations (full CRUD — implementation in Section 3.1.1):**

- **Add** — `POST /api/v1/positions` inserts a new row into `position_directory` with code, full title, description, tier, schedulability flag and display order. The foreign key on `employees.position` accepts the new code automatically. Audit event recorded.
- **Edit** — `PUT /api/v1/positions/:code` updates the full title, description, tier, schedulability or display order of an existing position. Changing a position code is not permitted once employees reference it. Toggling `is_schedulable` to `false` triggers revalidation of future published assignments for employees with that position — affected assignments are demoted to draft. Audit event recorded with previous values.
- **Delete** — `DELETE /api/v1/positions/:code` soft-deletes a position (sets `is_active = false`) only when no active employees hold that code and no active credential requirements target it. The `is_active` validation rejects the deactivated code for new assignments. The position remains in the directory for historical reference and audit trail integrity. Audit event recorded.

**Rules:**

- Every nursing unit belongs to exactly one department. A unit cannot exist without a parent department.
- Every employee is assigned to exactly one nursing unit via `employees.unit_id`. An employee cannot exist without a unit assignment. Unit transfers are administrative operations.
- Credential requirements are scoped to a unit (and optionally a position). The eligibility engine joins `credential_requirements.unit_id` to `employees.unit_id` — this relationship is unchanged.
- Shift assignments reference a unit. Coverage targets are configured per unit per shift. The `bed_count` value on a nursing unit informs staffing ratio calculations but does not automatically enforce a nurse-to-bed ratio — ratios are configured as coverage targets.
- Department membership determines reporting roll-ups (e.g. "Critical Care vacancy rate") but does not affect eligibility or scheduling — those operate at the unit level.
- Unit codes must be unique system-wide. Department codes must be unique system-wide.
- Soft-deleted departments and units remain visible in historical records, audit trails and past shift assignments. They are excluded from active dropdowns, scheduling and reporting.

**Implementation — database schema:**

```sql
-- prisma/migrations/V28_hospital_org_structure.sql
-- Departments, nursing units with bed capacity, and audit log

-- ============================================================
-- Step 1: Departments
-- ============================================================
CREATE TABLE departments (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(10) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT uq_department_code UNIQUE (code)
);

CREATE INDEX idx_departments_active ON departments(code) WHERE deleted_at IS NULL;

-- ============================================================
-- Step 2: Nursing units
-- ============================================================
CREATE TABLE nursing_units (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(20) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  department_id   INTEGER NOT NULL REFERENCES departments(id),
  bed_count       INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_bed_count_range CHECK (bed_count >= 0 AND bed_count <= 500),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT uq_unit_code UNIQUE (code)
);

CREATE INDEX idx_units_department ON nursing_units(department_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_units_active ON nursing_units(code) WHERE deleted_at IS NULL;

-- ============================================================
-- Step 3: Bed capacity change log
-- ============================================================
CREATE TABLE bed_capacity_log (
  id              BIGSERIAL PRIMARY KEY,
  unit_id         INTEGER NOT NULL REFERENCES nursing_units(id),
  previous_count  INTEGER NOT NULL,
  new_count       INTEGER NOT NULL,
  reason          VARCHAR(200),
  changed_by      INTEGER,       -- actor account ID; NULL for seed/migration
  changed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bcl_unit ON bed_capacity_log(unit_id, changed_at DESC);

-- ============================================================
-- Step 4: Migrate employees.unit_id to reference nursing_units
-- ============================================================
-- After seeding nursing_units, add the foreign key:
ALTER TABLE employees
  ADD CONSTRAINT fk_employee_unit
  FOREIGN KEY (unit_id) REFERENCES nursing_units(id);

-- Credential requirements also reference units:
ALTER TABLE credential_requirements
  ADD CONSTRAINT fk_cr_unit
  FOREIGN KEY (unit_id) REFERENCES nursing_units(id);

-- Shift assignments reference units:
ALTER TABLE shift_assignments
  ADD CONSTRAINT fk_sa_unit
  FOREIGN KEY (unit_id) REFERENCES nursing_units(id);
```

**Implementation — seed data:**

```sql
-- Seed departments
INSERT INTO departments (code, name, description) VALUES
  ('EMAC', 'Emergency & Acute Care',              'Emergency departments, urgent care and clinical decision units'),
  ('SURG', 'Surgical & Perioperative Services',    'Operating rooms, recovery and day surgery'),
  ('CRIT', 'Critical Care & Intensive Services',   'ICU, NICU, PICU, CCU and high-dependency units'),
  ('GNSP', 'General & Specialty Services',         'Inpatient wards, outpatient clinics and specialty units'),
  ('CORP', 'Administrative & Corporate Services',  'Nursing admin, HR, infection control and support services');

-- Seed nursing units (department_id resolved by subquery)
-- Emergency & Acute Care
INSERT INTO nursing_units (code, name, department_id, bed_count, description)
SELECT code, name, d.id, beds, descr FROM (VALUES
  ('ER_MAIN',   'ER Main / Adult',          'EMAC', 39, 'Primary triage and emergency care for adults'),
  ('ER_MC',     'ER M&C',                   'EMAC', 32, 'Emergency care for Mothers and Children'),
  ('UCC',       'Urgent Care Center',        'EMAC', 15, 'Urgent care for non-life-threatening needs'),
  ('CDU',       'Clinical Decision Unit',    'EMAC', 32, 'Observation unit for clinical decisions'),
  ('ER_COORD',  'ER Coordinator',            'EMAC',  0, 'Patient flow and resource management'),
  ('ED_NAV',    'ED Navigation',             'EMAC',  8, 'Patient routing and intake'),
  ('ED_ADMIN',  'ED Admin',                  'EMAC',  7, 'Clerical support for Emergency Department')
) AS t(code, name, dept, beds, descr)
JOIN departments d ON d.code = t.dept;

-- Surgical & Perioperative Services
INSERT INTO nursing_units (code, name, department_id, bed_count, description)
SELECT code, name, d.id, beds, descr FROM (VALUES
  ('OR',        'Operating Room',            'SURG', 12, 'Sterile surgical suites'),
  ('OR_COORD',  'OR Coordinator',            'SURG',  0, 'Surgical scheduling and theater flow'),
  ('PACU',      'Recovery / PACU',           'SURG',  8, 'Post-Anesthesia Care Unit'),
  ('DAY_SURG',  'Day Surgery',               'SURG',  9, 'Same-day surgical procedures'),
  ('PLASTER',   'Plaster Unit',              'SURG',  9, 'Orthopedic casting and splinting')
) AS t(code, name, dept, beds, descr)
JOIN departments d ON d.code = t.dept;

-- Critical Care & Intensive Services
INSERT INTO nursing_units (code, name, department_id, bed_count, description)
SELECT code, name, d.id, beds, descr FROM (VALUES
  ('ICU_MAIN',  'ICU Main',                  'CRIT', 79, 'Intensive care for critically ill adults'),
  ('ICU_EXT',   'ICU Extension',             'CRIT', 28, 'Overflow critical care capacity'),
  ('NICU',      'Neonatal Intensive Care',   'CRIT', 15, 'Neonatal intensive care'),
  ('PICU',      'Pediatric Intensive Care',  'CRIT', 15, 'Pediatric intensive care'),
  ('CCU',       'Coronary Care Unit',        'CRIT', 10, 'Cardiac intensive care'),
  ('BURN_ICU',  'Burn ICU',                  'CRIT',  6, 'Specialized care for burn trauma'),
  ('ASU',       'Acute Stabilization Unit',  'CRIT',  6, 'Acute stabilization'),
  ('HDU',       'High Dependency Unit',      'CRIT',  6, 'Step-down unit')
) AS t(code, name, dept, beds, descr)
JOIN departments d ON d.code = t.dept;

-- General & Specialty Services
INSERT INTO nursing_units (code, name, department_id, bed_count, description)
SELECT code, name, d.id, beds, descr FROM (VALUES
  ('INP_WARDS',  'Inpatient Wards',          'GNSP', 98, 'General and specialized acute care (3A-5B)'),
  ('AKU',        'Allergy and Kidney Unit',   'GNSP', 14, 'Allergy and kidney unit'),
  ('REHAB',      'Rehabilitation',            'GNSP', 17, 'Rehabilitation and physical therapy'),
  ('PEDIA',      'Pediatric Inpatient',       'GNSP', 15, 'Inpatient pediatric care'),
  ('LND',        'Labor and Delivery',        'GNSP', 15, 'Labor and delivery'),
  ('OBGYNE',     'Obstetrics & Gynecology',   'GNSP', 17, 'Obstetrics and gynecology'),
  ('NBS',        'Newborn Screening',         'GNSP',  3, 'Newborn screening unit'),
  ('OPD_DENTAL', 'OPD / Dental',             'GNSP', 23, 'Outpatient clinics'),
  ('JAIL',       'Jail Ward',                 'GNSP', 12, 'Secured unit for incarcerated patients'),
  ('RRT',        'Respiratory Rehab',         'GNSP',  5, 'Respiratory rehabilitation therapy'),
  ('ECHO_EEG',   'ECHO / EEG',               'GNSP',  2, 'Diagnostic electrical testing'),
  ('ENDO',       'Endoscopy',                 'GNSP',  5, 'GI visual diagnostics'),
  ('RADIOLOGY',  'Radiology',                 'GNSP',  6, 'Imaging services (X-Ray/CT/MRI)'),
  ('BLOOD_BANK', 'Blood Bank',               'GNSP',  2, 'Blood storage and donation'),
  ('LAB',        'Laboratory',                'GNSP',  0, 'Clinical pathology diagnostics'),
  ('DIABETIC',   'Diabetic Center',           'GNSP', 10, 'Specialized diabetes management'),
  ('DISCHARGE',  'Discharge Lounge',          'GNSP',  2, 'Transition area for departing patients')
) AS t(code, name, dept, beds, descr)
JOIN departments d ON d.code = t.dept;

-- Administrative & Corporate Services
INSERT INTO nursing_units (code, name, department_id, bed_count, description)
SELECT code, name, d.id, beds, descr FROM (VALUES
  ('NURS_ADMIN',  'Nursing Admin',            'CORP',  0, 'Nursing staff management'),
  ('HR',          'Human Resources',           'CORP',  0, 'Human resources and payroll'),
  ('IC',          'Infection Control',          'CORP',  0, 'Infection control'),
  ('PAT_EXP',    'Patient Experience',         'CORP',  0, 'Patient satisfaction and feedback'),
  ('PAT_AFFAIRS', 'Patient Affairs',           'CORP',  0, 'Admissions and patient rights'),
  ('ACADEMIC',   'Academic Affairs',            'CORP',  0, 'Medical education and training'),
  ('BIZ_CENTER', 'Business Center',            'CORP',  0, 'Finance and billing'),
  ('IDARA',      'Idara',                      'CORP',  0, 'General management office'),
  ('STORE',      'Store',                      'CORP',  0, 'Supply chain and inventory'),
  ('HOME_CARE',  'Home Care',                  'CORP',  0, 'Coordination of home-based medical care')
) AS t(code, name, dept, beds, descr)
JOIN departments d ON d.code = t.dept;

-- Log initial bed capacity for all units
INSERT INTO bed_capacity_log (unit_id, previous_count, new_count, reason)
SELECT id, 0, bed_count, 'Initial seed from Hospital Master Unit Directory'
FROM nursing_units
WHERE bed_count > 0;
```

**Implementation — Prisma schema:**

```prisma
model Department {
  id          Int            @id @default(autoincrement())
  code        String         @unique @db.VarChar(10)
  name        String         @db.VarChar(100)
  description String?
  isActive    Boolean        @default(true) @map("is_active")
  createdAt   DateTime       @default(now()) @map("created_at")
  updatedAt   DateTime       @default(now()) @map("updated_at")
  deletedAt   DateTime?      @map("deleted_at")
  units       NursingUnit[]

  @@map("departments")
}

model NursingUnit {
  id            Int             @id @default(autoincrement())
  code          String          @unique @db.VarChar(20)
  name          String          @db.VarChar(100)
  description   String?
  departmentId  Int             @map("department_id")
  bedCount      Int             @default(0) @map("bed_count")
  isActive      Boolean         @default(true) @map("is_active")
  createdAt     DateTime        @default(now()) @map("created_at")
  updatedAt     DateTime        @default(now()) @map("updated_at")
  deletedAt     DateTime?       @map("deleted_at")
  department    Department      @relation(fields: [departmentId], references: [id])
  capacityLog   BedCapacityLog[]

  @@map("nursing_units")
}

model BedCapacityLog {
  id            BigInt       @id @default(autoincrement())
  unitId        Int          @map("unit_id")
  previousCount Int          @map("previous_count")
  newCount      Int          @map("new_count")
  reason        String?      @db.VarChar(200)
  changedBy     Int?         @map("changed_by")
  changedAt     DateTime     @default(now()) @map("changed_at")
  unit          NursingUnit  @relation(fields: [unitId], references: [id])

  @@index([unitId, changedAt(sort: Desc)])
  @@map("bed_capacity_log")
}
```

**Implementation — API endpoints:**

```typescript
// src/modules/workforce/controllers/departments.controller.ts
@Controller('api/v1/departments')
@UseGuards(AuthGuard, RbacGuard)
export class DepartmentsController {
  constructor(private readonly workforceService: WorkforceService) {}

  @Get()
  async listDepartments(@Query('includeInactive') includeInactive?: boolean) {
    return this.workforceService.getDepartments({ includeInactive });
  }

  @Post()
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async createDepartment(@Body() dto: CreateDepartmentDto) {
    return this.workforceService.createDepartment(dto);
  }

  @Put(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async updateDepartment(@Param('id') id: number, @Body() dto: UpdateDepartmentDto) {
    return this.workforceService.updateDepartment(id, dto);
  }

  @Delete(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async deleteDepartment(@Param('id') id: number) {
    return this.workforceService.softDeleteDepartment(id);
  }
}

// src/modules/workforce/controllers/units.controller.ts
@Controller('api/v1/units')
@UseGuards(AuthGuard, RbacGuard)
export class UnitsController {
  constructor(private readonly workforceService: WorkforceService) {}

  @Get()
  async listUnits(
    @Query('departmentId') departmentId?: number,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    return this.workforceService.getUnits({ departmentId, includeInactive });
  }

  @Post()
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async createUnit(@Body() dto: CreateUnitDto) {
    return this.workforceService.createUnit(dto);
  }

  @Put(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async updateUnit(@Param('id') id: number, @Body() dto: UpdateUnitDto) {
    return this.workforceService.updateUnit(id, dto);
  }

  @Put(':id/bed-capacity')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async updateBedCapacity(
    @Param('id') id: number,
    @Body() dto: UpdateBedCapacityDto,
    @Request() req,
  ) {
    return this.workforceService.updateBedCapacity(id, dto, req.user.id);
  }

  @Delete(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async deleteUnit(@Param('id') id: number) {
    return this.workforceService.softDeleteUnit(id);
  }

  @Get(':id/bed-history')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR')
  async getBedHistory(@Param('id') id: number) {
    return this.workforceService.getBedCapacityHistory(id);
  }
}
```

**Implementation — bed capacity update with audit logging:**

```typescript
// src/modules/workforce/workforce.service.ts
async updateBedCapacity(
  unitId: number,
  dto: UpdateBedCapacityDto,
  actorId: number,
): Promise<NursingUnit> {
  return this.prisma.$transaction(async (tx) => {
    const unit = await tx.nursingUnit.findUnique({ where: { id: unitId } });
    if (!unit || unit.deletedAt) throw new NotFoundException('Unit not found');

    const previousCount = unit.bedCount;

    // Log the change
    await tx.bedCapacityLog.create({
      data: {
        unitId,
        previousCount,
        newCount: dto.bedCount,
        reason: dto.reason,
        changedBy: actorId,
      },
    });

    // Update the unit
    return tx.nursingUnit.update({
      where: { id: unitId },
      data: { bedCount: dto.bedCount, updatedAt: new Date() },
    });
  });
}
```

**Implementation — entering the required numbers: bulk capacity update and CSV import:**

Units and bed counts are configuration data, not release data. Two endpoints set the required numbers in one action; both run in a single transaction per batch and write one `bed_capacity_log` row per changed unit.

```typescript
// src/modules/workforce/controllers/units.controller.ts
@Put('bed-capacity/bulk')
@RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
async bulkUpdateBedCapacity(@Body() dto: BulkBedCapacityDto, @Req() req) {
  return this.workforceService.bulkUpdateBedCapacity(dto, req.user.id);
}

@Post('import')
@RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
async importUnits(@Body() dto: ImportUnitsDto, @Req() req) {
  // dryRun = true validates and reports without writing; dry-run is the default
  return this.workforceService.importUnits(dto, req.user.id, dto.dryRun ?? true);
}
```

```typescript
// src/modules/workforce/workforce.service.ts — one transaction per batch
async bulkUpdateBedCapacity(dto: BulkBedCapacityDto, actorId: number) {
  return this.prisma.$transaction(async (tx) => {
    const results: BulkRowResult[] = [];

    for (const row of dto.rows) {
      const unit = await tx.nursingUnit.findUnique({ where: { code: row.unitCode } });

      if (!unit || unit.deletedAt) {
        results.push({ unitCode: row.unitCode, status: 'REJECTED', reason: 'Unknown or deleted unit' });
        continue;
      }
      if (row.bedCount < 0 || row.bedCount > 500) {
        results.push({ unitCode: row.unitCode, status: 'REJECTED', reason: 'Bed count must be 0–500' });
        continue;
      }
      if (unit.bedCount === row.bedCount) {
        results.push({ unitCode: row.unitCode, status: 'UNCHANGED' });
        continue;
      }

      await tx.bedCapacityLog.create({
        data: {
          unitId: unit.id,
          previousCount: unit.bedCount,
          newCount: row.bedCount,
          reason: dto.reason ?? 'Bulk capacity configuration',
          changedBy: actorId,
        },
      });
      await tx.nursingUnit.update({
        where: { id: unit.id },
        data: { bedCount: row.bedCount, updatedAt: new Date() },
      });
      results.push({
        unitCode: row.unitCode,
        status: 'UPDATED',
        previous: unit.bedCount,
        next: row.bedCount,
      });
    }

    await this.auditService.logDomainEvent(tx, {
      action: 'BED_CAPACITY_BULK_UPDATED',
      resource: 'nursing_units',
      changes: {
        updated:   results.filter((r) => r.status === 'UPDATED').length,
        unchanged: results.filter((r) => r.status === 'UNCHANGED').length,
        rejected:  results.filter((r) => r.status === 'REJECTED').length,
      },
    });

    return results;
  });
}
```

**CSV import format** (`POST /api/v1/units/import`): columns `unit_code,name,department_code,beds,description`. `dryRun: true` (the default) validates every row — unknown department, unknown or duplicate unit code, bed count outside 0–500 — and returns a per-row report without writing. `dryRun: false` applies the valid rows in one transaction and returns rejected rows for correction. The importer never deletes units; removing a unit remains the guarded soft-delete operation described below.

**UI — Unit & Bed Capacity Configuration screen:** an editable grid grouped by department showing code, name, beds and the running total, with "Baseline 582 → Configured N" displayed live and the current configuration exportable to CSV. The total comes from `GET /api/v1/units/summary` — the same value the coverage and staffing-ratio views read — so entering the required numbers is verifiable on one screen and takes effect immediately.

**Implementation — soft delete with referential safety:**

```typescript
// Department soft delete — only when no active units exist
async softDeleteDepartment(id: number): Promise<void> {
  const activeUnits = await this.prisma.nursingUnit.count({
    where: { departmentId: id, deletedAt: null },
  });
  if (activeUnits > 0) {
    throw new ConflictException(
      `Cannot delete department: ${activeUnits} active unit(s) must be reassigned or deleted first`,
    );
  }
  await this.prisma.department.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
}

// Unit soft delete — only when no active references exist
async softDeleteUnit(id: number): Promise<void> {
  const [activeEmployees, futureAssignments, activeCredRules] = await Promise.all([
    this.prisma.employee.count({ where: { unitId: id, deletedAt: null } }),
    this.prisma.shiftAssignment.count({
      where: { unitId: id, shiftDate: { gt: new Date() }, status: 'Published' },
    }),
    this.prisma.credentialRequirement.count({
      where: { unitId: id, isMandatory: true },
    }),
  ]);

  const blockers: string[] = [];
  if (activeEmployees > 0) blockers.push(`${activeEmployees} active employee(s)`);
  if (futureAssignments > 0) blockers.push(`${futureAssignments} future published assignment(s)`);
  if (activeCredRules > 0) blockers.push(`${activeCredRules} active credential rule(s)`);

  if (blockers.length > 0) {
    throw new ConflictException(
      `Cannot delete unit: ${blockers.join(', ')} must be reassigned first`,
    );
  }

  await this.prisma.nursingUnit.update({
    where: { id },
    data: { deletedAt: new Date(), isActive: false },
  });
}
```

**Pre-migration safety check:**

Before applying the foreign keys, verify that all existing `unit_id` values in `employees`, `credential_requirements` and `shift_assignments` match a seeded `nursing_units.id`:

```sql
-- Detect employees referencing unknown unit IDs
SELECT e.id, e.job_number, e.unit_id
FROM employees e
LEFT JOIN nursing_units nu ON nu.id = e.unit_id
WHERE e.deleted_at IS NULL AND nu.id IS NULL;

-- Detect credential requirements referencing unknown unit IDs
SELECT cr.id, cr.unit_id, cr.template_id
FROM credential_requirements cr
LEFT JOIN nursing_units nu ON nu.id = cr.unit_id
WHERE nu.id IS NULL;
```

If either returns rows, HR must resolve the references before the migration proceeds.

**Acceptance criteria for hospital organizational structure:**

| Criterion | Required evidence |
| :--- | :--- |
| Departments seeded | 5 departments exist with correct codes, names and descriptions |
| Units configured | Every unit in the active configuration has a valid parent department, a unique code and a bed count within 0–500; the seeded baseline is 47 units across 5 departments |
| Bed capacity total | `GET /api/v1/units/summary` returns a total equal to the sum of active units' bed counts at test time (seeded baseline: 582). The criterion verifies internal consistency and correct recomputation after edits — not a frozen number — so configuration changes never invalidate the test |
| Bulk configuration | `PUT /api/v1/units/bed-capacity/bulk` and `POST /api/v1/units/import` (dry-run, then commit) apply a full required bed plan in one action; each changed unit writes a `bed_capacity_log` row with actor and reason; negative or >500 values and unknown unit codes are rejected with per-row errors |
| FK integrity | Inserting an employee with a non-existent unit_id is rejected at the database level |
| Department CRUD | HR Admin can add, edit and soft-delete departments; delete blocked when active units exist |
| Unit CRUD | HR Admin can add, edit and soft-delete units; delete blocked when active employees, assignments or credential rules exist |
| Bed capacity CRUD | HR Admin can update bed capacity; every change logged in `bed_capacity_log` with previous value, new value, reason and actor |
| Bed capacity history | `GET /api/v1/units/:id/bed-history` returns chronological log of all capacity changes |
| Position CRUD | HR Admin can add, edit and deprecate positions via `position_directory`; delete blocked when active employees hold the code |
| Soft delete visibility | Soft-deleted departments and units excluded from active dropdowns but visible in historical records and audit trails |
| Coverage integration | Coverage monitoring reads `bed_count` from `nursing_units`; staffing ratio calculations reflect current capacity |
| Frontend selectors | Onboarding form unit selector reads from API, grouped by department; bed capacity shown in unit management view |

### 2.10 Frontend globalized experience (i18n)

**Specification:** The system must support a bilingual interface (English and Arabic) to serve the diverse international nursing workforce and local administration.

**Implementation — i18n framework:**

- **Framework:** `i18next` and `react-i18next`. All UI strings are stored in external JSON translation files (`en.json`, `ar.json`). No hardcoded strings in components.
- **RTL support:** The system detects the selected language. When Arabic is selected, the application toggles the `dir="rtl"` attribute on the HTML body. Ant Design components are configured via `ConfigProvider` with `direction="rtl"` to flip layouts for the Arabic interface.
- **Bilingual notifications:** All SMTP and push notifications are sent using bilingual templates. The system reads the user's preferred language from their profile and delivers the notification in that language.
- **Date/number formatting:** Use of the `Intl` API to ensure dates and numbers are formatted according to the user's locale (Gregorian vs Hijri calendars).

**Acceptance criteria for i18n:**

| Criterion | Required evidence |
| :--- | :--- |
| Language switch | Switching language updates the entire UI instantly without a page reload |
| RTL layout | Arabic layout mirrors the English layout correctly (sidebar, tables, forms all flip to RTL) |
| Notification language | Notifications are delivered in the language specified in the user's profile |
| No hardcoded strings | A search of component files confirms zero hardcoded user-facing strings outside translation files |

---

## 3. Identity, authentication and onboarding

### 3.1 Contract-first onboarding

**Specification:** Employee accounts are created through a strictly contract-first workflow. To eliminate the risk of "Ghost Employees" (records without legal contracts), the system uses a **Database-Enforced Atomic Onboarding** mechanism.

**The Bulletproof Rule:** Direct `INSERT` access to the `employees` and `contracts` tables is revoked from the application runtime. All onboarding must occur via a `SECURITY DEFINER` database function that guarantees an employee and an approved contract are created in a single, atomic transaction.

**Workflow:**

1. Scoped HR opens **New Employee and Contract / Workforce Setup**.
2. HR enters the employee record: First Name, Middle Name and Last Name — **Full Name is derived from the three parts, never typed** — then, in this order: Job Number (unique; **no format rule**, a plain number or a text-and-number combination are both accepted), Job Title, File No., Rank/Grade, Nationality, Job Post (Location Assignment — City), Actual Work Place, Specialty, Contract Start and Contract End (both required; entered as Gregorian dates with the Umm al-Qura Hijri equivalent converted and stored alongside), Marital Status and Salary in Saudi Riyals — plus organizational placement, position and contact email.
3. The API calls the `fn_onboard_employee_with_contract` database function.
4. The database creates the Employee Master, the Approved Contract and the Audit Entry in one atomic block.
5. If any step fails (e.g. duplicate Job Number or invalid contract dates), the entire operation is rolled back by the database engine.

**Employee record (2.8.7c).** The onboarding form and the `employees` table carry the fields below. **Full Name is derived, never entered:** a trigger recomposes it from First + Middle + Last on every write, so the stored value cannot drift from its parts and an omitted Middle Name leaves no double space.

| # | Field | Column | Rule |
| :--- | :--- | :--- | :--- |
| 1 | First Name | `first_name` | Required |
| 2 | Middle Name | `middle_name` | Optional |
| 3 | Last Name | `last_name` | Required |
| — | Full Name | `full_name` | **Derived** by `trg_employees_compose_full_name` = First + Middle + Last. Never supplied by a caller; a generated column is rejected because the ORM writes `full_name` explicitly and PostgreSQL refuses writes to generated columns. |
| 4 | Job Number | `job_number` | Required, unique. **No format rule** — a plain number (`1001`) or a text-and-number combination (`AIGH1002`, `EMP2004`) are both valid. The retired `AIGH-XXXX` pattern is neither required nor enforced, and no `CHECK` constraint may reintroduce it. |
| 5 | Job Title | `job_title` | — |
| 6 | File No. | `file_no` | Personnel-file reference. Not constrained unique; HR may leave it blank. |
| 7 | Rank/Grade | `rank_grade` | — |
| 8 | Nationality | `nationality` | — |
| 9 | Job Post (Location Assignment) — City | `job_post_location` | — |
| 10 | Actual Work Place | `actual_work_place` | — |
| 11 | Specialty | `specialty` | — |
| 12 | Contract Start | `contracts.start_date` + `start_date_hijri` | Required. Gregorian entry; the Umm al-Qura equivalent is converted and stored with it. |
| 13 | Contract End | `contracts.end_date` + `end_date_hijri` | Required, strictly after the start. Same conversion. |
| 14 | Marital Status | `marital_status` | `Single` / `Married` / `Others` |
| 15 | Salary | `salary` | Amount in Saudi Riyals, `NUMERIC(12,2)`, non-negative |

Fields 4–15 appear in this order on the onboarding form. Schema: `prisma/migrations/V50_employee_hr_fields.sql`.

**Implementation — database gatekeeper (V36):**

```sql
-- prisma/migrations/V36_bulletproof_onboarding.sql

CREATE OR REPLACE FUNCTION fn_onboard_employee_with_contract(
    -- Name parts. full_name is NOT a parameter: the trigger derives it (2.8.7c).
    p_first_name VARCHAR,
    p_middle_name VARCHAR,
    p_last_name VARCHAR,
    -- No format rule applies to the job number: plain number or text+number (2.8.7c).
    p_job_number VARCHAR,
    p_job_title VARCHAR,
    p_file_no VARCHAR,
    p_rank_grade VARCHAR,
    p_nationality VARCHAR,
    p_job_post_location VARCHAR,
    p_actual_work_place VARCHAR,
    p_specialty VARCHAR,
    p_marital_status VARCHAR,
    p_salary NUMERIC,
    p_unit_id INTEGER,
    p_position VARCHAR,
    p_contact_email VARCHAR,
    p_contract_start DATE,
    p_contract_end DATE,
    -- Umm al-Qura equivalents, converted by the caller and stored as entered (2.8.7c).
    p_contract_start_hijri VARCHAR,
    p_contract_end_hijri VARCHAR,
    p_actor_id INTEGER
) RETURNS INTEGER AS $$
DECLARE
    v_employee_id INTEGER;
BEGIN
    -- Only active positions may be assigned (mirrors the WorkforceService check)
    IF NOT EXISTS (
      SELECT 1 FROM position_directory
      WHERE code = p_position AND is_active = true
    ) THEN
      RAISE EXCEPTION 'POSITION_NOT_ACTIVE: %', p_position USING ERRCODE = 'check_violation';
    END IF;

    -- Step A: Create the Employee Master.
    -- full_name and name are deliberately absent: trg_employees_compose_full_name
    -- derives both from the three name parts on this same INSERT (2.8.7c).
    INSERT INTO employees (
      first_name, middle_name, last_name,
      job_number, job_title, file_no, rank_grade, nationality,
      job_post_location, actual_work_place, specialty, marital_status, salary,
      unit_id, position, contact_email, created_at
    )
    VALUES (
      p_first_name, p_middle_name, p_last_name,
      p_job_number, p_job_title, p_file_no, p_rank_grade, p_nationality,
      p_job_post_location, p_actual_work_place, p_specialty, p_marital_status, p_salary,
      p_unit_id, p_position, p_contact_email, now()
    )
    RETURNING id INTO v_employee_id;

    -- Step B: Create the Initial Approved Contract
    -- This physically enforces the "Contract-First" rule
    INSERT INTO contracts (employee_id, start_date, end_date,
                           start_date_hijri, end_date_hijri, status, created_at)
    VALUES (v_employee_id, p_contract_start, p_contract_end,
            p_contract_start_hijri, p_contract_end_hijri, 'Approved', now());

    -- Step C: Log the domain audit event through the canonical chained path
    -- (Section 9.1). A direct INSERT would bypass the hash chain.
    PERFORM fn_append_audit_entry(
      p_actor_id,
      'EMPLOYEE_ONBOARDED',
      'employees',
      v_employee_id::text,
      jsonb_build_object(
        'job_number', p_job_number,
        'first_name', p_first_name,
        'middle_name', p_middle_name,
        'last_name', p_last_name,
        'contract_start', p_contract_start,
        'contract_end', p_contract_end,
        'contract_start_hijri', p_contract_start_hijri,
        'contract_end_hijri', p_contract_end_hijri
      )
    );

    RETURN v_employee_id;
END;
$$ LANGUAGE plpgsql
   SECURITY DEFINER
   -- Required on SECURITY DEFINER functions to prevent search_path hijacking.
   SET search_path = pg_catalog, public;

-- Deliberately NO "EXCEPTION WHEN OTHERS" handler: it would mask duplicate
-- job-number, foreign-key and permission failures behind one generic message
-- and make support diagnosis impossible. The function is a single statement,
-- so any raised error still rolls the whole call back atomically.
```

**Implementation — application service:**

```typescript
// src/modules/workforce/workforce.service.ts

async onboardEmployee(dto: OnboardEmployeeDto, actorId: number): Promise<number> {
  // Standard prisma.employee.create() will fail with "Permission Denied"
  // Use $queryRaw to invoke the secure database function
  const result = await this.prisma.$queryRaw`
    SELECT fn_onboard_employee_with_contract(
      ${dto.firstName},
      ${dto.middleName ?? null},
      ${dto.lastName},
      ${dto.jobNumber},
      ${dto.jobTitle},
      ${dto.fileNo},
      ${dto.rankGrade},
      ${dto.nationality},
      ${dto.jobPostLocation},
      ${dto.actualWorkPlace},
      ${dto.specialty},
      ${dto.maritalStatus},
      ${dto.salary},
      ${dto.unitId},
      ${dto.position},
      ${dto.contactEmail},
      ${dto.contractStart},
      ${dto.contractEnd},
      // Umm al-Qura equivalents of the two dates, converted at the edge (2.8.7c)
      ${dto.contractStartHijri},
      ${dto.contractEndHijri},
      ${actorId}
    ) as employee_id;
  `;

  return (result as any)[0].employee_id;
}
```

Supported positions are maintained in the `position_directory` reference table (see Section 3.1.1). Active position codes: DON, DEPUTY_DON, ADMIN, NS, ACTING_HEAD, NURSE_EDUCATOR, PRACTITIONER, HN, CN, SN, PCT, TEC, HCA, MW. Deprecated codes AHN and CI are retained in the directory with `is_active = false` for audit history. Non-schedulable positions (DON, DEPUTY_DON, ADMIN) are not eligible for shift assignment. Employee position and security role are separate concepts — a clinical title never automatically confers administrative access.

### 3.1.1 Position directory

**Specification:** The system maintains a canonical position directory that defines every recognized nursing and administrative position. The directory serves as the single source of truth for position codes, display labels, organizational tiers, scheduling eligibility and active/deprecated status. The `employees.position` column is constrained to values in this directory.

**Position catalog:**

| Code | Full Title | Tier | Schedulable | Status |
| :--- | :--- | :--- | :--- | :--- |
| DON | Director of Nursing | Executive | No | Active |
| DEPUTY_DON | Deputy Director of Nursing | Executive | No | Active |
| ADMIN | Administrator | Administrative | No | Active |
| NS | Nursing Supervisor | Management | Yes | Active |
| ACTING_HEAD | Acting Head Nurse | Management | Yes | Active |
| NURSE_EDUCATOR | Clinical Nurse Educator | Specialist | Yes | Active |
| PRACTITIONER | Nurse Practitioner | Advanced Practice | Yes | Active |
| HN | Head Nurse | Management | Yes | Active |
| CN | Charge Nurse | Clinical Lead | Yes | Active |
| SN | Staff Nurse | Clinical | Yes | Active |
| PCT | Patient Care Technician | Support | Yes | Active |
| TEC | Technician | Support | Yes | Active (legacy) |
| HCA | Healthcare Assistant | Support | Yes | Active (legacy) |
| MW | Midwife | Clinical Specialist | Yes | Active (legacy) |
| AHN | Acting/Assistant Head Nurse | Management | Yes | Deprecated → ACTING_HEAD |
| CI | Clinical Instructor | Specialist | Yes | Deprecated → NURSE_EDUCATOR |

**Position tiers:**

- **Executive** — hospital nursing leadership (DON, DEPUTY_DON). Not scheduled to clinical shifts. System access requires explicit HR Admin or System Admin role assignment.
- **Administrative** — non-clinical operations staff (ADMIN). Not scheduled to clinical shifts. May receive HR Admin or Scheduler authorization role by explicit assignment.
- **Management** — unit-level and multi-unit supervisory staff (NS, ACTING_HEAD, HN). Schedulable. May receive Supervisor authorization role by explicit assignment.
- **Specialist** — training and education staff (NURSE_EDUCATOR). Schedulable when assigned to clinical duties. Credential requirements may differ from frontline nursing.
- **Advanced Practice** — nurses with expanded clinical scope (PRACTITIONER). Schedulable. Requires position-specific credential rules including advanced practice licensure.
- **Clinical Lead** — shift-level leadership (CN). Schedulable.
- **Clinical** — frontline registered nursing staff (SN). Schedulable.
- **Clinical Specialist** — specialist practitioners (MW). Schedulable.
- **Support** — patient care support staff (PCT, TEC, HCA). Schedulable.

**Legacy code migration:** Existing employees with position code `AHN` are migrated to `ACTING_HEAD`. Existing employees with position code `CI` are migrated to `NURSE_EDUCATOR`. The migration updates both the `employees` table and any `contracts` or `credential_requirements` rows referencing the deprecated codes. Deprecated codes remain in the `position_directory` table with `is_active = false` for audit trail integrity.

**Rules:**

- The `employees.position` column is constrained by a foreign key to `position_directory(code)`. To ensure only active positions are assigned to new employees, `WorkforceService` validates that `position_directory.is_active = true` before any INSERT or UPDATE to the employee record. Deprecated codes are rejected by this validation after migration.
- Position codes in `credential_requirements.position` reference `position_directory.code` via foreign key. This ensures credential rules cannot reference invalid or unknown positions.
- The position selector in the onboarding form reads from `position_directory` where `is_active = true`, ordered by `display_order`, grouped by `tier` for usability.
- Non-schedulable positions (DON, DEPUTY_DON, ADMIN) can exist in the system for credential tracking, compliance reporting and organizational structure without being eligible for shift assignment.
- Adding a new position code to the directory is done through the `POST /api/v1/positions` endpoint (Section 3.1.1). Because `employees.position` references `position_directory(code)` via foreign key, no manual schema migration is needed to accept new codes. The frontend reads the directory dynamically via `GET /api/v1/positions`.

**Implementation — database schema:**

```sql
-- prisma/migrations/V27_position_directory.sql
-- Position directory reference table and constraint

CREATE TABLE position_directory (
  code            VARCHAR(20) PRIMARY KEY,
  full_title      VARCHAR(100) NOT NULL,
  description     TEXT,
  tier            VARCHAR(30) NOT NULL,
  is_schedulable  BOOLEAN NOT NULL DEFAULT true,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  display_order   SMALLINT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO position_directory (code, full_title, description, tier, is_schedulable, is_active, display_order) VALUES
  ('DON',            'Director of Nursing',         'Executive leadership, strategic planning, and overall clinical governance.',          'Executive',         false, true,  1),
  ('DEPUTY_DON',     'Deputy Director of Nursing',  'Operational management and implementation of nursing standards.',                    'Executive',         false, true,  2),
  ('ADMIN',          'Administrator',               'Non-clinical operations, budgeting, staffing schedules, and procurement.',           'Administrative',    false, true,  3),
  ('NS',             'Nursing Supervisor',           'Multi-unit shift coordination and resource allocation.',                            'Management',        true,  true,  4),
  ('ACTING_HEAD',    'Acting Head Nurse',            'Temporary leadership of a unit to ensure continuity of care and management.',       'Management',        true,  true,  5),
  ('NURSE_EDUCATOR', 'Clinical Nurse Educator',      'Staff training, onboarding, and maintaining clinical competency.',                  'Specialist',        true,  true,  6),
  ('PRACTITIONER',   'Nurse Practitioner',           'Advanced practice nurse capable of diagnostics and prescribing.',                   'Advanced Practice', true,  true,  7),
  ('HN',             'Head Nurse',                   'Unit-specific management, staff oversight, and quality control.',                   'Management',        true,  true,  8),
  ('CN',             'Charge Nurse',                 'Shift-lead responsible for patient assignments and immediate unit needs.',          'Clinical Lead',     true,  true,  9),
  ('SN',             'Staff Nurse',                  'Frontline registered nurse providing direct bedside patient care.',                 'Clinical',          true,  true,  10),
  ('PCT',            'Patient Care Technician',      'Support staff providing basic patient care, vitals, and hygiene.',                  'Support',           true,  true,  11),
  ('TEC',            'Technician',                   'Technical support staff. Legacy position retained for existing records.',           'Support',           true,  true,  12),
  ('HCA',            'Healthcare Assistant',         'Healthcare support assistant. Legacy position retained for existing records.',      'Support',           true,  true,  13),
  ('MW',             'Midwife',                      'Specialist midwifery practitioner. Legacy position retained for existing records.', 'Clinical Specialist', true, true, 14),
  ('AHN',            'Acting/Assistant Head Nurse',  'Deprecated — migrate to ACTING_HEAD.',                                             'Management',        true,  false, 99),
  ('CI',             'Clinical Instructor',          'Deprecated — migrate to NURSE_EDUCATOR.',                                          'Specialist',        true,  false, 98);
```

**Implementation — pre-migration safety check:**

Before applying the constraint, the migration runner detects employees with position values outside the recognized set and stops for HR resolution. It does not silently discard or reassign unknown position values. Run this check first:

```sql
-- Detect employees with unrecognized position values
SELECT id, job_number, position
FROM employees
WHERE position IS NOT NULL
  AND position NOT IN (
    'DON','DEPUTY_DON','ADMIN','ACTING_HEAD','NURSE_EDUCATOR',
    'PRACTITIONER','NS','HN','CN','SN','PCT','TEC','HCA','MW',
    'AHN','CI'
  )
  AND deleted_at IS NULL;
```

If this returns rows, HR must resolve each record before the migration proceeds.

**Implementation — legacy code migration:**

```sql
-- Migrate deprecated position codes
UPDATE employees SET position = 'ACTING_HEAD', updated_at = now()
WHERE position = 'AHN' AND deleted_at IS NULL;

UPDATE employees SET position = 'NURSE_EDUCATOR', updated_at = now()
WHERE position = 'CI' AND deleted_at IS NULL;

UPDATE contracts SET position = 'ACTING_HEAD'
WHERE position = 'AHN';

UPDATE contracts SET position = 'NURSE_EDUCATOR'
WHERE position = 'CI';

UPDATE credential_requirements SET position = 'ACTING_HEAD'
WHERE position = 'AHN';

UPDATE credential_requirements SET position = 'NURSE_EDUCATOR'
WHERE position = 'CI';
```

**Implementation — position constraint and references:**

```sql
-- Foreign key on employees.position → position_directory(code)
-- Replaces the invalid subquery-based CHECK constraint (see revision 2.8.1).
ALTER TABLE employees
  ADD CONSTRAINT fk_employee_position
  FOREIGN KEY (position) REFERENCES position_directory(code);

-- Foreign key from credential_requirements.position
ALTER TABLE credential_requirements
  ADD CONSTRAINT fk_cr_position
  FOREIGN KEY (position) REFERENCES position_directory(code);

-- Index for position-based queries
CREATE INDEX idx_employees_position ON employees(position)
  WHERE deleted_at IS NULL;
```

**Implementation — Prisma schema:**

```prisma
model PositionDirectory {
  code          String    @id @db.VarChar(20)
  fullTitle     String    @map("full_title") @db.VarChar(100)
  description   String?
  tier          String    @db.VarChar(30)
  isSchedulable Boolean   @default(true) @map("is_schedulable")
  isActive      Boolean   @default(true) @map("is_active")
  displayOrder  Int       @default(0) @map("display_order") @db.SmallInt
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @default(now()) @map("updated_at")

  @@map("position_directory")
}
```

**Implementation — DTO validation:**

```typescript
// src/modules/workforce/dto/create-employee.dto.ts
import { IsIn } from 'class-validator';

const VALID_POSITIONS = [
  'DON', 'DEPUTY_DON', 'ADMIN', 'ACTING_HEAD', 'NURSE_EDUCATOR',
  'PRACTITIONER', 'NS', 'HN', 'CN', 'SN', 'PCT',
  'TEC', 'HCA', 'MW',
] as const;

export type NursingPosition = typeof VALID_POSITIONS[number];

// In the DTO class:
@IsIn(VALID_POSITIONS, { message: 'Invalid position code' })
position: NursingPosition;
```

**Implementation — position directory CRUD API:**

```typescript
// src/modules/workforce/controllers/positions.controller.ts
@Controller('api/v1/positions')
@UseGuards(AuthGuard, RbacGuard)
export class PositionsController {
  constructor(private readonly workforceService: WorkforceService) {}

  // ── Read ──────────────────────────────────────────────────
  @Get()
  async listPositions(
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    return this.workforceService.getPositions({ includeInactive });
  }

  @Get(':code')
  async getPosition(@Param('code') code: string) {
    return this.workforceService.getPositionByCode(code);
  }

  // ── Create ────────────────────────────────────────────────
  @Post()
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async createPosition(@Body() dto: CreatePositionDto) {
    return this.workforceService.createPosition(dto);
  }

  // ── Update ────────────────────────────────────────────────
  @Put(':code')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async updatePosition(
    @Param('code') code: string,
    @Body() dto: UpdatePositionDto,
  ) {
    return this.workforceService.updatePosition(code, dto);
  }

  // ── Delete (soft) ─────────────────────────────────────────
  @Delete(':code')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async deletePosition(@Param('code') code: string) {
    return this.workforceService.softDeletePosition(code);
  }
}
```

**Implementation — position DTOs:**

```typescript
// src/modules/workforce/dto/create-position.dto.ts
import { IsString, IsBoolean, IsInt, IsOptional, Matches, MaxLength, Min, Max } from 'class-validator';

export class CreatePositionDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,19}$/, {
    message: 'Position code must be uppercase alphanumeric with underscores, 2–20 characters',
  })
  code: string;

  @IsString()
  @MaxLength(100)
  fullTitle: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsString()
  @MaxLength(30)
  tier: string;

  @IsBoolean()
  isSchedulable: boolean;

  @IsInt()
  @Min(0)
  @Max(99)
  displayOrder: number;
}

// src/modules/workforce/dto/update-position.dto.ts
import { IsString, IsBoolean, IsInt, IsOptional, MaxLength, Min, Max } from 'class-validator';

export class UpdatePositionDto {
  @IsString() @MaxLength(100) @IsOptional()
  fullTitle?: string;

  @IsString() @IsOptional()
  description?: string;

  @IsString() @MaxLength(30) @IsOptional()
  tier?: string;

  @IsBoolean() @IsOptional()
  isSchedulable?: boolean;

  @IsInt() @Min(0) @Max(99) @IsOptional()
  displayOrder?: number;

  // code is NOT updatable — see service enforcement below
}
```

**Implementation — position service methods:**

```typescript
// src/modules/workforce/workforce.service.ts — position CRUD

// ── List ──────────────────────────────────────────────────
async getPositions(opts: { includeInactive?: boolean }): Promise<PositionDirectoryEntry[]> {
  return this.prisma.positionDirectory.findMany({
    where: opts.includeInactive ? {} : { isActive: true },
    orderBy: { displayOrder: 'asc' },
  });
}

// ── Read one ─────────────────────────────────────────────
async getPositionByCode(code: string): Promise<PositionDirectoryEntry> {
  const position = await this.prisma.positionDirectory.findUnique({
    where: { code },
  });
  if (!position) throw new NotFoundException(`Position ${code} not found`);
  return position;
}

// ── Create ───────────────────────────────────────────────
async createPosition(dto: CreatePositionDto): Promise<PositionDirectoryEntry> {
  // Check for duplicate code
  const existing = await this.prisma.positionDirectory.findUnique({
    where: { code: dto.code },
  });
  if (existing) {
    throw new ConflictException(`Position code ${dto.code} already exists`);
  }

  return this.prisma.$transaction(async (tx) => {
    // Insert the position
    const position = await tx.positionDirectory.create({
      data: {
        code: dto.code,
        fullTitle: dto.fullTitle,
        description: dto.description,
        tier: dto.tier,
        isSchedulable: dto.isSchedulable,
        displayOrder: dto.displayOrder,
        isActive: true,
      },
    });

    // No schema migration is required: employees.position references
    // position_directory(code) via foreign key, so the new code is
    // immediately valid for assignment once is_active = true.

    // Audit the creation
    await this.auditService.logDomainEvent(tx, {
      action: 'POSITION_CREATED',
      resource: 'position_directory',
      resourceId: dto.code,
      changes: { code: dto.code, fullTitle: dto.fullTitle, tier: dto.tier },
    });

    return position;
  });
}

// ── Update ───────────────────────────────────────────────
async updatePosition(
  code: string,
  dto: UpdatePositionDto,
): Promise<PositionDirectoryEntry> {
  const position = await this.prisma.positionDirectory.findUnique({
    where: { code },
  });
  if (!position) throw new NotFoundException(`Position ${code} not found`);

  return this.prisma.$transaction(async (tx) => {
    const updated = await tx.positionDirectory.update({
      where: { code },
      data: {
        ...(dto.fullTitle !== undefined && { fullTitle: dto.fullTitle }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.tier !== undefined && { tier: dto.tier }),
        ...(dto.isSchedulable !== undefined && { isSchedulable: dto.isSchedulable }),
        ...(dto.displayOrder !== undefined && { displayOrder: dto.displayOrder }),
        updatedAt: new Date(),
      },
    });

    // If schedulability changed, revalidate future assignments
    if (dto.isSchedulable !== undefined && dto.isSchedulable !== position.isSchedulable) {
      await this.revalidateAssignmentsForPosition(tx, code);
    }

    // Audit the update
    await this.auditService.logDomainEvent(tx, {
      action: 'POSITION_UPDATED',
      resource: 'position_directory',
      resourceId: code,
      changes: dto,
      previousValues: {
        fullTitle: position.fullTitle,
        tier: position.tier,
        isSchedulable: position.isSchedulable,
      },
    });

    return updated;
  });
}

// ── Delete (soft) ────────────────────────────────────────
async softDeletePosition(code: string): Promise<void> {
  const position = await this.prisma.positionDirectory.findUnique({
    where: { code },
  });
  if (!position) throw new NotFoundException(`Position ${code} not found`);
  if (!position.isActive) {
    throw new ConflictException(`Position ${code} is already inactive`);
  }

  // Check for active employees holding this position
  const activeEmployees = await this.prisma.employee.count({
    where: { position: code, deletedAt: null },
  });
  if (activeEmployees > 0) {
    throw new ConflictException(
      `Cannot delete position ${code}: ${activeEmployees} active employee(s) hold this code. ` +
      `Reassign employees to a different position first.`,
    );
  }

  // Check for active credential requirements targeting this position
  const activeCredRules = await this.prisma.credentialRequirement.count({
    where: { position: code, isMandatory: true },
  });
  if (activeCredRules > 0) {
    throw new ConflictException(
      `Cannot delete position ${code}: ${activeCredRules} active credential rule(s) target it. ` +
      `Remove or reassign credential rules first.`,
    );
  }

  await this.prisma.$transaction(async (tx) => {
    // Soft delete: set is_active = false
    await tx.positionDirectory.update({
      where: { code },
      data: { isActive: false, updatedAt: new Date() },
    });

    // No schema migration is required: the soft-deleted position is
    // excluded from assignment by the WorkforceService is_active validation.

    // Audit the deletion
    await this.auditService.logDomainEvent(tx, {
      action: 'POSITION_DELETED',
      resource: 'position_directory',
      resourceId: code,
      changes: { isActive: false, previousTitle: position.fullTitle },
    });
  });
}

// ── Revalidation helper ──────────────────────────────────
private async revalidateAssignmentsForPosition(
  tx: PrismaTransactionClient,
  positionCode: string,
): Promise<void> {
  // Find future published assignments for employees with this position
  const affected = await tx.$queryRaw<Array<{ id: number }>>`
    SELECT sa.id
    FROM shift_assignments sa
    JOIN employees e ON sa.employee_id = e.id
    WHERE e.position = ${positionCode}
      AND sa.shift_date > CURRENT_DATE
      AND sa.status = 'Published'
      AND e.deleted_at IS NULL
  `;

  if (affected.length > 0) {
    // Demote to draft for supervisor review
    await tx.shiftAssignment.updateMany({
      where: { id: { in: affected.map(a => a.id) } },
      data: { status: 'Draft' },
    });

    // Notify scoped supervisors
    for (const assignment of affected) {
      await this.notificationService.createSystemNotification(tx, {
        type: 'ASSIGNMENT_DEMOTED',
        resourceId: assignment.id,
        reason: `Position ${positionCode} schedulability changed — assignment moved to draft for review`,
      });
    }
  }
}
```

**Implementation — foreign key and active-position validation:**

The `employees.position` column references `position_directory(code)` via a foreign key, replacing the invalid subquery-based `CHECK` constraint from earlier revisions (PostgreSQL does not permit subqueries inside `CHECK` constraints). Adding or removing a position via the API therefore requires no manual migration — the foreign key accepts any code present in the directory.

To ensure only **active** positions are assigned, `WorkforceService` validates `position_directory.is_active = true` before any INSERT or UPDATE to the employee record. A position deactivated via the API is immediately rejected for new employee records. Existing employees who already hold a deactivated position code are not affected — the validation fires only on INSERT or UPDATE of the `position` column.

The frontend position selector in the onboarding form replaces its hardcoded position list with `GET /api/v1/positions` and groups results by `tier`:

- Executive: DON, DEPUTY_DON
- Administrative: ADMIN
- Management: NS, ACTING_HEAD, HN
- Specialist: NURSE_EDUCATOR
- Advanced Practice: PRACTITIONER
- Clinical Lead: CN
- Clinical: SN
- Clinical Specialist: MW
- Support: PCT, TEC, HCA

**Post-migration verification:**

```sql
-- Verify no employees remain on deprecated codes
SELECT count(*) FROM employees
WHERE position IN ('AHN', 'CI') AND deleted_at IS NULL;
-- Expected: 0

-- Verify future published assignments for migrated employees
SELECT e.id, e.job_number, e.position, sa.shift_date, sa.status
FROM employees e
JOIN shift_assignments sa ON sa.employee_id = e.id
WHERE e.position IN ('ACTING_HEAD', 'NURSE_EDUCATOR')
  AND sa.shift_date > CURRENT_DATE
  AND sa.status = 'Published'
  AND e.deleted_at IS NULL
ORDER BY sa.shift_date;
-- Review: revalidation trigger should have rechecked these assignments
```

**Acceptance criteria for position directory:**

| Criterion | Required evidence |
| :--- | :--- |
| Directory seeded | All 16 positions exist in `position_directory` with correct tier, schedulability and active status |
| Legacy migration | Zero employees have position `AHN` or `CI`; all migrated to `ACTING_HEAD` or `NURSE_EDUCATOR` |
| Foreign key | Inserting an employee with a position code absent from `position_directory` is rejected at the database level |
| FK integrity | Creating a credential requirement referencing a non-existent position code is rejected |
| Position list | `GET /api/v1/positions` returns 14 active positions ordered by `display_order`; `?includeInactive=true` returns all 16 |
| Position read | `GET /api/v1/positions/:code` returns full detail for one position |
| Position create | `POST /api/v1/positions` by HR Admin creates a new position; duplicate code rejected with 409; foreign key accepts the new code automatically; audit event recorded |
| Position update | `PUT /api/v1/positions/:code` by HR Admin updates title, description, tier, schedulability or display order; position code is immutable; schedulability change triggers revalidation of future published assignments; audit event recorded with previous values |
| Position delete | `DELETE /api/v1/positions/:code` by HR Admin soft-deletes (sets `is_active = false`); blocked with 409 when active employees hold the code or active credential rules target it; `is_active` validation rejects the deactivated code for new assignments; audit event recorded |
| Revalidation on schedulability change | Toggling `is_schedulable` to `false` demotes future published assignments for employees with that position to draft; supervisor notification generated |
| Authorization | Only HR Admin and System Admin can create, update or delete positions; all authenticated users can list and read |
| Frontend selector | Onboarding form shows grouped position dropdown from API; deprecated/deleted codes do not appear in the selector but remain visible in employee history views |
| Revalidation | Future published assignments for migrated employees are rechecked; invalid ones demoted to draft |
| Audit trail | Position create, update and delete events are recorded in the domain audit log with actor, action and changes |
| Credential rules | HR has configured mandatory credential rules for PRACTITIONER, NS, DON, DEPUTY_DON and ADMIN before employees are onboarded with those codes |

### 3.2 Employee registration

**Specification:** Registration is invitation-based and guarded by eligibility checks.

**Rules:**

- HR issues a single-use invitation to an approved email address for an unclaimed employee with current approved employment coverage.
- Invitations expire after 72 hours and store a token hash. Issuing a new invitation invalidates earlier unused invitations for that employee.
- The email contains the private link; no invitation token is returned as ordinary administrative screen data.
- The employee uses the invitation and Job Number to preview their linked details. Job Number alone does not disclose employee information.
- The employee must use the invited email and choose a 12–72 character password.
- Registration repeats eligibility checks, locks the invitation and employee record, creates one login account and links it to that employee. Concurrent attempts can produce only one successful claim.
- New accounts receive the staff self-service authorization role and personal data scope. That default role does not grant supervisor authority.
- Registration attempts use a persistent per-client throttle.

### 3.3 Login and session management

**Specification:** The system uses bcrypt password hashing, JWT access tokens and rotating refresh tokens with replay detection.

**Rules:**

- Login accepts username or email and applies account/client attempt limits.
- JWTs carry numeric account identifiers and a session binding.
- Refresh tokens are stored as hashes, rotated on use and consumed atomically — replay is rejected.
- Session expiry comparisons use UTC. Workforce date rules use Asia/Riyadh.
- Default session limits: one hour of validity, 24-hour absolute boundary.
- The refresh token's nominal lifetime does not bypass session expiry or revocation.
- Changing a password verifies the current password and revokes all active sessions.
- Employees can change their own phone number and password and view their own login/session history.
- Job Number, employment dates, unit, position, identity data and contact email changes remain administrative operations.

### 3.4 Browser session hardening

**Specification:** Refresh tokens are stored in HttpOnly cookies that JavaScript cannot access. Access tokens are short-lived (15 minutes) and held only in a JavaScript variable. All state-changing requests require a CSRF token.

**Target architecture:**

| Token | Storage | Lifetime | Purpose |
| :--- | :--- | :--- | :--- |
| Refresh token | `HttpOnly`, `Secure`, `SameSite=Lax` cookie named `nurseapp_refresh`, scoped to `/api/v1/auth` | 24 hours | Obtain new access tokens. Not `__Host-`: that prefix requires `Path=/`. Lax (not Strict) so the cookie survives the SSO redirect planned in Section 3.5 |
| Access token | JavaScript variable in memory | 15 minutes | Authorize API requests |
| CSRF token | Returned in login/refresh response body, sent as `X-CSRF-Token` header | Per session | Prevent cross-site request forgery |

**Implementation — backend login endpoint:**

```typescript
// src/modules/identity/auth.controller.ts

// Path-scoped cookie name. The __Host- prefix is deliberately NOT used here:
// browsers reject any __Host- cookie whose Path is not exactly "/", and this
// cookie is scoped to the auth endpoints.
const REFRESH_COOKIE = 'nurseapp_refresh';

@Post('login')
async login(@Body() dto: LoginDto, @Res() res: Response) {
  const { accessToken, refreshToken, csrfToken } =
    await this.authService.login(dto);

  // Refresh token → HttpOnly cookie (JS can never read this)
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,          // not accessible to JavaScript
    secure:   true,          // HTTPS only
    sameSite: 'lax',         // Lax, not Strict: Strict blocks the IdP redirect planned in Section 3.5
    path:     '/api/v1/auth', // only sent to auth endpoints
    maxAge:   24 * 60 * 60 * 1000, // 24h absolute boundary
  });

  // Access token + CSRF token → response body (held in JS memory)
  res.json({ accessToken, csrfToken });
}
```

**Implementation — backend refresh endpoint:**

```typescript
// src/modules/identity/auth.controller.ts
@Post('refresh')
async refresh(@Req() req: Request, @Res() res: Response) {
  const oldRefresh = req.cookies[REFRESH_COOKIE];
  if (!oldRefresh) throw new UnauthorizedException();

  // Existing rotation + replay detection logic stays unchanged
  const { accessToken, refreshToken, csrfToken } =
    await this.authService.rotateRefresh(oldRefresh);

  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true, secure: true, sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: 24 * 60 * 60 * 1000,
  });

  res.json({ accessToken, csrfToken });
}
```

**Implementation — CSRF protection guard:**

```typescript
// src/modules/identity/guards/csrf.guard.ts
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { timingSafeEqual } from 'crypto';

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest();

    // Skip CSRF check for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;

    // Validate Origin header matches expected host
    const origin = req.headers['origin'];
    const expected = process.env.APP_ORIGIN;
    if (!origin || origin !== expected) return false;

    // Validate CSRF token from header matches session token.
    // PRECONDITION: the authentication guard has already run — see the
    // registration note below. If req.user is empty, this guard must fail
    // closed rather than fall through.
    const headerToken = req.headers['x-csrf-token'];
    const sessionToken = req.user?.csrfToken;
    if (!headerToken || !sessionToken) return false;

    const a = Buffer.from(headerToken);
    const b = Buffer.from(sessionToken);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}
```

Register `CsrfGuard` **after** authentication. NestJS runs global guards
before controller-scoped guards, so an `APP_GUARD`-registered CSRF guard reads
`req.user` before the auth guard has populated it and rejects every
state-changing request. Apply the guards together at controller level, in order:

```typescript
// src/modules/workforce/controllers/workforce.controller.ts
@Controller('api/v1/workforce')
@UseGuards(AuthGuard, RbacGuard, CsrfGuard) // order matters: authenticate, then check CSRF
export class WorkforceController {}

// src/app.module.ts — do NOT register CsrfGuard as APP_GUARD
// providers: [{ provide: APP_GUARD, useClass: CsrfGuard }]   ← removed in 2.8.7
```

If a single global check is preferred, the guard must resolve the session
itself (from the refresh cookie and the session store) instead of reading
`req.user`.

**Implementation — authentication environment configuration:**

```env
# .env.production — Authentication and session section
APP_ORIGIN=https://nurseapp.aigh.sa            # approved Origin for CSRF validation; must match the URL staff use
JWT_SECRET=${JWT_SECRET}                        # from deployment secrets — minimum 256-bit random value
JWT_ACCESS_EXPIRY_SECONDS=900                   # 15-minute access token lifetime
JWT_REFRESH_EXPIRY_SECONDS=86400                # 24-hour absolute session boundary
BCRYPT_ROUNDS=12                                # password hashing cost factor
REGISTRATION_THROTTLE_WINDOW_MS=900000          # 15-minute window for per-client registration attempts
REGISTRATION_THROTTLE_MAX=5                     # max registration attempts per window
```

**Implementation — frontend auth (React):**

```typescript
// src/lib/auth.ts
// Access token lives ONLY in a JS variable — never localStorage
let accessToken: string | null = null;
let csrfToken: string | null = null;

export async function login(username: string, password: string) {
  const res = await fetch('/api/v1/auth/login', {
    method: 'POST',
    credentials: 'same-origin',   // sends/receives cookies
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  accessToken = data.accessToken;
  csrfToken   = data.csrfToken;
}

export async function apiFetch(path: string, opts: RequestInit = {}) {
  const headers = new Headers(opts.headers);
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`);
  if (csrfToken)   headers.set('X-CSRF-Token', csrfToken);

  let res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });

  // Auto-refresh on 401
  if (res.status === 401) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      headers.set('Authorization', `Bearer ${accessToken}`);
      headers.set('X-CSRF-Token', csrfToken!);
      res = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    }
  }
  return res;
}

async function refreshTokens(): Promise<boolean> {
  // Cookie is sent automatically — no token in the body
  const res = await fetch('/api/v1/auth/refresh', {
    method: 'POST',
    credentials: 'same-origin',
  });
  if (!res.ok) { accessToken = null; csrfToken = null; return false; }
  const data = await res.json();
  accessToken = data.accessToken;
  csrfToken   = data.csrfToken;
  return true;
}
```

**Security outcomes:**

- XSS can no longer steal the refresh token — `HttpOnly` prevents JavaScript access.
- CSRF attacks are blocked — the Origin check plus the `X-CSRF-Token` header provide defense in depth. `SameSite=Lax` keeps the cookie usable across the IdP redirect (Section 3.5) while still refusing cross-site POSTs.
- Existing refresh rotation is preserved — only the transport mechanism changes.
- Shared hospital workstations are safer — closing the browser tab clears the in-memory access token.

### 3.5 Future identity enhancements — planned

- Add hospital SSO when the identity provider and account-linking policy are established. Local roles and record scopes still apply after SSO.
- Add MFA for privileged accounts (HR Admin, System Admin).
- Use separate database identities for runtime (limited), migration (schema owner) and backup (read-only). Keep credentials in the deployment secret facility, never in source control or logs.

**Implementation — PAM & dual-authorization logic:**

```typescript
// src/modules/identity/pam/pam.service.ts
@Injectable()
export class PamService {
  /**
   * Checks if the user currently has an active privileged session.
   */
  async isElevated(userId: number): Promise<boolean> {
    const session = await this.prisma.privilegedSession.findUnique({
      where: { user_id: userId }
    });
    if (!session) return false;
    if (new Date() > session.expires_at) {
      await this.revokeElevation(userId);
      return false;
    }
    return true;
  }

  async requestElevation(userId: number, reason: string, durationHrs: number) {
    return this.prisma.privilegedSession.upsert({
      where: { user_id: userId },
      update: {
        expires_at: new Date(Date.now() + durationHrs * 3600000),
        reason
      },
      create: {
        user_id: userId,
        reason,
        expires_at: new Date(Date.now() + durationHrs * 3600000)
      },
    });
  }
}

// src/modules/identity/governance/approval.service.ts
@Injectable()
export class AdminApprovalService {
  // (imports: NotFoundException, ConflictException, ForbiddenException)
  async approveAction(requestId: number, approverId: number) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Lock the request row so two approvers cannot both proceed
      const rows = await tx.$queryRaw<AdminApprovalRequest[]>`
        SELECT * FROM admin_approval_requests
        WHERE id = ${requestId}
        FOR UPDATE
      `;
      const request = rows[0];
      if (!request) throw new NotFoundException('Approval request not found');

      // 2. Only a PENDING request may be approved (blocks replay/re-approval)
      if (request.status !== 'PENDING') {
        throw new ConflictException(
          `Request ${requestId} is ${request.status} and cannot be approved`,
        );
      }

      // 3. Four-eyes: prevent self-approval
      if (request.initiator_id === approverId) {
        throw new ForbiddenException('Self-approval of high-impact actions is forbidden.');
      }

      // 4. Execute the payload on the SAME transaction client, so a failure
      //    rolls back both the action and the status change.
      await this.executeAction(tx, request.action_type, request.request_payload);

      // 5. Record the terminal state
      return tx.adminApprovalRequest.update({
        where: { id: requestId },
        data: { status: 'EXECUTED', approver_id: approverId, approved_at: new Date() },
      });
    });
  }
}
```

### 3.6 Emergency access (break-glass)

**Specification:** To prevent system deadlock (e.g., if the PAM database is corrupted or the only admin is unavailable), the system implements a Break-Glass Root Account.

**The protocol:**

- **The account** — a single, high-privilege account whose credentials are split into two halves (stored physically in separate hospital safes).
- **The bypass** — this account bypasses the `PamService` (Just-In-Time elevation) and the `AdminApprovalService` (Four-Eyes principle), granting immediate root access.
- **The siren** — any login attempt using the Break-Glass account triggers an immediate Siren Event:
  - An irrevocable entry is written to `break_glass_events`.
  - An emergency SMS/Email alert is sent to the Hospital CEO and the IT Director.
  - The session is limited to 4 hours, after which it is forcibly revoked.

**Implementation — siren trigger:**

```typescript
// src/modules/identity/auth/break-glass.service.ts
async triggerSiren(rootUserId: number, reason: string, ip: string) {
  await this.prisma.breakGlassEvents.create({
    data: { actor_id: rootUserId, reason, ip_address: ip }
  });

  // Non-blocking emergency broadcast
  await this.notificationService.sendEmergencyAlert({
    title: '🚨 SYSTEM BREAK-GLASS ACTIVATED',
    message: `Root access granted to ${rootUserId}. Reason: ${reason}. IP: ${ip}`,
    priority: 'CRITICAL'
  });
}
```

---

## 4. Contracts

### 4.1 Access and scope

**Specification:** All contract operations enforce server-evaluated scope for the authenticated caller. Passing a nurse ID from the browser does not establish access.

| Role | Access level |
| :--- | :--- |
| HR / System Admin | Scoped create, approval, renewal, termination; full contract history and attachments |
| Supervisor | Scoped reduced read view: identifiers, employee/position, unit, status, dates |
| Employee | Own reduced read view |

### 4.2 Approval, effectiveness and overlap

**Specification:** Contracts follow a strict lifecycle with database-enforced overlap prevention.

**Rules:**

- Draft and PendingApproval records do not provide employment coverage.
- Approving a contract that covers today makes it Active immediately.
- Approving a future-period contract leaves it as Approved until its start date; approval does not supersede the current contract.
- Both Approved and Active periods participate in a database exclusion constraint. Overlapping periods for the same employee are rejected at the database level.
- An Approved future period can satisfy eligibility for a shift within that future period.
- Start and end dates are inclusive. The next nonoverlapping renewal starts after the previous end date.
- **Contract dates are recorded in both calendars (2.8.7c).** Contract Start and Contract End are required. HR enters a Gregorian date and the Umm al-Qura (Saudi official) equivalent is converted and stored alongside it as `start_date_hijri` / `end_date_hijri`. The Gregorian pair stays authoritative for all coverage arithmetic; the Hijri pair is the human-facing record, stored rather than recomputed so it cannot drift if a runtime's calendar tables are updated. Conversion uses `Intl` with the `islamic-umalqura` calendar extension, which is the only basis accepted for these fields.
- Expired, Suspended, Terminated and Superseded records do not provide coverage.
- The system does not support concurrent secondary contracts. Deliberate replacement requires explicit HR handling; silent superseding has been removed.
- **Guards belong to the service layer, not to a screen (2.8.7c).** Contract creation and update reject: a contract whose employee does not exist or is soft-deleted (`EMPLOYEE_NOT_FOUND`); a period whose end is on or before its start; and an `Approved` or `Active` period that overlaps another `Approved`/`Active` period for the same employee (`CONTRACT_PERIOD_OVERLAP`). These checks must not live only in a UI component — the API, background jobs and any future caller pass through the same path. `Draft` and `PendingApproval` provide no coverage and may therefore sit on an existing period until approved. The database exclusion constraint remains the final authority; the service check exists so the failure is explained before it reaches the database.

**Renewal entry (2.8.7c).** The Create Contract form appends the Contract Start and Contract End recorded at onboarding: selecting an employee displays that period in both calendars and prefills the pickers with a renewal that starts the day after the previous end and runs for the same length, which satisfies the exclusion constraint by construction. The prefilled dates remain editable, and the guard in the rule above still applies to whatever HR finally submits.

**Implementation — overlap exclusion constraint:**

```sql
-- Applied via migration: prevents overlapping Approved/Active contracts per employee
ALTER TABLE contracts
  ADD CONSTRAINT no_overlapping_active_contracts
  EXCLUDE USING gist (
    employee_id WITH =,
    daterange(start_date, end_date, '[]') WITH &&
  )
  WHERE (status IN ('Approved', 'Active'));
```

**Implementation — pre-migration safety check:**

Before applying the constraint, the migration runner detects existing active overlaps and stops for HR resolution. It does not silently resolve them. Run this check first:

```sql
-- Detect existing overlaps before adding the constraint
SELECT a.id AS contract_a, b.id AS contract_b, a.employee_id,
       a.start_date, a.end_date, b.start_date, b.end_date
FROM contracts a
JOIN contracts b ON a.employee_id = b.employee_id
  AND a.id < b.id
  AND a.status IN ('Approved', 'Active')
  AND b.status IN ('Approved', 'Active')
  AND daterange(a.start_date, a.end_date, '[]') && daterange(b.start_date, b.end_date, '[]');
```

If this returns rows, HR must resolve each overlap before the migration proceeds.

---

## 5. Credentials and evidence

### 5.1 Credential catalog

**Specification:** The system maintains a two-level credential catalog: **categories** group related credential types, and **credential templates** within each category define the specific document type, its tracked data fields, expiry behavior and upload requirements. The catalog is fully manageable via CRUD operations by HR Admin and System Admin. Credential templates drive the eligibility engine — every credential held by an employee references a template, and mandatory credential requirements reference templates by ID.

#### 5.1.1 Credential categories

Categories are organizational groupings. They determine how credentials are displayed in the UI (grouped sections in the employee credential view, category filters in compliance reports) but do not affect eligibility logic — that operates at the template level.

| Category Code | Category Name | Description |
| :--- | :--- | :--- |
| IDENTITY | Identity & Legal | Government-issued identification and legal residency documents |
| LICENSURE | Licensure | Professional and national practice licenses |
| LIABILITY | Liability & Clearance | Employment contracts, insurance and background clearances |
| COMPETENCY | Clinical Competency | Clinical skills assessments and specialized certifications |
| LIFE_SUPPORT | Life Support | Emergency and life-saving certifications |

**CRUD operations — categories:**

- **Add** — `POST /api/v1/credential-categories` creates a new category with a unique code and name.
- **Edit** — `PUT /api/v1/credential-categories/:code` updates the name or description. Code is immutable once templates reference it.
- **Delete** — `DELETE /api/v1/credential-categories/:code` soft-deletes only when no active templates belong to it. Templates must be reassigned or deleted first.

#### 5.1.2 Credential templates

Each template defines a credential type with its specific tracking fields, expiry behavior and upload requirements. Templates are seeded from the Staff Credential Tracking Template and can be extended by HR.

**Full credential template catalog:**

| Category | Template Code | Template Name | Tracked Fields | Has Expiry | Upload |
| :--- | :--- | :--- | :--- | :--- | :--- |
| IDENTITY | PASSPORT | Passport | Passport Number, Issuing Country, Issue Date, Expiry Date | Yes | Image/PDF |
| IDENTITY | IQAMA | Resident ID (Iqama) | Iqama Number, Sponsor/Employer Name, Issue Date, Expiry Date (Gregorian/Hijri), Job Title | Yes | Image/PDF |
| IDENTITY | HOSPITAL_ID | Hospital ID | Employee ID Number, Department/Cost Center, Issue Date, Expiry Date | Yes | Image/PDF |
| LICENSURE | PROF_LICENSE | Professional License | License Number, Issuing Board, Issuing Country, Issue Date, Expiry Date | Yes | Image/PDF |
| LICENSURE | SCFHS | Saudi Council License | SCFHS Registration Number, Professional Classification, Issue Date, Expiry Date | Yes | Image/PDF |
| LIABILITY | EMP_CONTRACT | Employment Contract | Contract ID/Reference No., Contracting Agency, Start Date, Expiry Date | Yes | Image/PDF |
| LIABILITY | MALPRACTICE | Medical Malpractice | Policy Number, Insurance Provider, Effective Date, Expiry Date | Yes | Image/PDF |
| LIABILITY | CLEARANCE | Staff Clearance | Clearance Form ID, Medical Fitness Status, Background Check Status, Approval Date | No | Image/PDF |
| COMPETENCY | CORE_COMP | Core Generic Competency | Assessment Date, Evaluator Name, Pass/Fail Status, Next Reassessment Due Date | Yes (reassessment) | Image/PDF |
| COMPETENCY | UNIT_COMP | Unit Specific Competency | Assigned Unit, Assessment Date, Evaluator Name, Pass/Fail Status, Next Reassessment Due Date | Yes (reassessment) | Image/PDF |
| COMPETENCY | SEDATION | Conscious Sedation | Certificate Number, Certifying Department, Issue Date, Expiry Date, Supervised Cases Count | Yes | Image/PDF |
| LIFE_SUPPORT | BLS | BLS | Certificate Number, Training Provider, Issue Date, Expiry Date | Yes | Image/PDF |
| LIFE_SUPPORT | ACLS | ACLS | Certificate Number, Training Provider, Issue Date, Expiry Date | Yes | Image/PDF |
| LIFE_SUPPORT | PALS | PALS | Certificate Number, Training Provider, Issue Date, Expiry Date | Yes | Image/PDF |
| LIFE_SUPPORT | NRP | NRP | Certificate Number, Training Provider, Issue Date, Expiry Date | Yes | Image/PDF |
| LIFE_SUPPORT | BICSL | BICSL | Certificate Number, Training Facility, Issue Date, Expiry Date | Yes | Image/PDF |

The credential Employment Contract template (EMP_CONTRACT) is an attachment — employment eligibility comes from the Contract Master (Section 4), not from this document record.

**CRUD operations — templates:**

- **Add** — `POST /api/v1/credential-templates` creates a new template with code, name, category, field definitions, expiry behavior and upload requirement. Audit event recorded.
- **Edit** — `PUT /api/v1/credential-templates/:id` updates the name, description, field definitions, expiry settings or category. Template code is immutable once credentials reference it. Audit event recorded.
- **Delete** — `DELETE /api/v1/credential-templates/:id` soft-deletes only when no active credentials reference it and no mandatory requirements target it. Audit event recorded.
- **List** — `GET /api/v1/credential-templates` returns all active templates grouped by category. `?includeInactive=true` includes soft-deleted templates. `?categoryCode=IDENTITY` filters by category.
- **Read** — `GET /api/v1/credential-templates/:id` returns full template detail including field definitions.

#### 5.1.3 Template field definitions

Each credential template defines a set of **tracking fields** — the data points captured when an employee submits or HR reviews a credential. Fields are stored as a JSON schema in the template record, enabling HR to add custom fields to new templates without code changes.

**Common field types:**

| Field Type | Description | Example |
| :--- | :--- | :--- |
| `text` | Free-text string | Passport Number, License Number, Policy Number |
| `date` | Date value (ISO 8601) | Issue Date, Expiry Date, Assessment Date |
| `date_hijri` | Hijri calendar date with Gregorian conversion | Expiry Date (Hijri) on Iqama |
| `select` | Predefined choice list | Pass/Fail Status, Medical Fitness Status, Professional Classification |
| `number` | Integer value | Supervised Cases Count |
| `country` | ISO country code | Issuing Country |
| `reference` | FK to another system entity | Assigned Unit (→ nursing_units), Certifying Department |

**Field definition schema (stored as JSONB on credential_templates):**

```json
{
  "fields": [
    {
      "key": "passport_number",
      "label": "Passport Number",
      "type": "text",
      "required": true,
      "displayOrder": 1
    },
    {
      "key": "issuing_country",
      "label": "Issuing Country",
      "type": "country",
      "required": true,
      "displayOrder": 2
    },
    {
      "key": "issue_date",
      "label": "Issue Date",
      "type": "date",
      "required": true,
      "isIssueDate": true,
      "displayOrder": 3
    },
    {
      "key": "expiry_date",
      "label": "Expiry Date",
      "type": "date",
      "required": true,
      "isExpiryDate": true,
      "displayOrder": 4
    }
  ]
}
```

Fields marked `isExpiryDate: true` drive the notification scan (Section 7.1) and eligibility engine (Section 6.1). Fields marked `isIssueDate: true` are used in the eligibility date-range check.

#### 5.1.4 Credential requirements management

**Specification:** Credential requirements define which templates are mandatory for which unit/position combinations. They are the rules the eligibility engine (Section 6.1) evaluates — if no rules exist for a unit/position, scheduling is blocked. Requirements now have full CRUD via API.

**CRUD operations — credential requirements:**

- **Add** — `POST /api/v1/credential-requirements` creates a rule linking a template to a unit (required) and optionally a position. `is_mandatory` flag controls whether it blocks eligibility. Audit event recorded.
- **Edit** — `PUT /api/v1/credential-requirements/:id` updates the mandatory flag, position scope or template reference. Triggers revalidation of future published assignments for affected employees. Audit event recorded.
- **Delete** — `DELETE /api/v1/credential-requirements/:id` removes the rule. Triggers revalidation — removing a mandatory requirement may make previously ineligible employees eligible. Audit event recorded.
- **List** — `GET /api/v1/credential-requirements` returns all rules. `?unitId=5` filters by unit. `?position=SN` filters by position. `?templateId=3` filters by template. Grouped by unit in the response.
- **Bulk set** — `POST /api/v1/credential-requirements/bulk` accepts an array of {templateId, unitId, position?, isMandatory} entries and applies them in one transaction. Used during initial hospital configuration.

**Rules:**

- A requirement with `position = NULL` applies to all positions in that unit.
- A requirement with a specific position applies only to employees holding that position in that unit.
- Position-specific rules override unit-wide rules for the same template — if both exist, the position-specific rule takes precedence.
- Deleting a credential requirement does not delete credentials employees already hold — it only removes the eligibility gate.
- Adding a new mandatory requirement immediately affects eligibility for employees who lack that credential.

#### 5.1.5 Evidence upload and tracking

**Specification:** Employees submit credential evidence as image (JPEG, PNG, WebP) or PDF uploads. Each submission creates a new document version linked to the employee's credential record. The upload enters the quarantine pipeline (Section 5.3.2) before becoming available for HR review.

**Upload rules:**

- Accepted formats: `application/pdf`, `image/jpeg`, `image/png`, `image/webp`.
- Maximum file size: 10 MB per upload (configurable via `UPLOAD_MAX_SIZE_BYTES`).
- Magic bytes verification: detected MIME type must match declared `Content-Type`.
- Each upload creates a versioned evidence record with the employee ID, template ID, file bytes (or object storage reference), content type, file size, original filename, scan status and upload timestamp.
- Previous approved evidence remains accessible even while a replacement is pending review.
- Employees can view and download their own evidence. HR can view and download evidence for employees within their scope. Supervisors see compliance status but cannot download evidence files.

**Tracking fields on credential records:**

Every credential record held by an employee stores the tracking field values defined by its template, plus these common system fields:

| System Field | Type | Description |
| :--- | :--- | :--- |
| `employee_id` | FK → employees | The employee who holds this credential |
| `template_id` | FK → credential_templates | Which credential type this is |
| `validity_status` | enum | PendingVerification, Valid, ExpiringSoon, Expired, Suspended, Revoked |
| `issue_date` | DATE | When the credential was issued (from the `isIssueDate` tracking field) |
| `expiry_date` | DATE | When the credential expires (from the `isExpiryDate` tracking field) |
| `tracking_data` | JSONB | All template-defined tracking field values |
| `latest_evidence_id` | FK → credential_evidence | Current approved document version |
| `verified_by` | FK → accounts | HR user who last reviewed/approved |
| `verified_at` | TIMESTAMPTZ | When last reviewed/approved |

**Implementation — database schema:**

```sql
-- prisma/migrations/V29_credential_catalog_crud.sql
-- Credential categories, templates with field definitions, and requirements CRUD

-- ============================================================
-- Step 1: Credential categories
-- ============================================================
CREATE TABLE credential_categories (
  id              SERIAL PRIMARY KEY,
  code            VARCHAR(20) NOT NULL,
  name            VARCHAR(100) NOT NULL,
  description     TEXT,
  display_order   SMALLINT NOT NULL DEFAULT 0,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  CONSTRAINT uq_cred_category_code UNIQUE (code)
);

-- Seed categories
INSERT INTO credential_categories (code, name, description, display_order) VALUES
  ('IDENTITY',     'Identity & Legal',       'Government-issued identification and legal residency documents',  1),
  ('LICENSURE',    'Licensure',              'Professional and national practice licenses',                    2),
  ('LIABILITY',    'Liability & Clearance',  'Employment contracts, insurance and background clearances',       3),
  ('COMPETENCY',   'Clinical Competency',    'Clinical skills assessments and specialized certifications',      4),
  ('LIFE_SUPPORT', 'Life Support',           'Emergency and life-saving certifications',                       5);

-- ============================================================
-- Step 2: Credential templates (replaces implicit schema)
-- ============================================================
-- If credential_templates already exists from the baseline,
-- this migration adds the missing columns:
ALTER TABLE credential_templates
  ADD COLUMN IF NOT EXISTS code              VARCHAR(20),
  ADD COLUMN IF NOT EXISTS category_id       INTEGER REFERENCES credential_categories(id),
  ADD COLUMN IF NOT EXISTS field_definitions  JSONB NOT NULL DEFAULT '{"fields":[]}',
  ADD COLUMN IF NOT EXISTS has_expiry        BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS requires_upload   BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS display_order     SMALLINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- Add unique constraint on template code
ALTER TABLE credential_templates
  ADD CONSTRAINT uq_cred_template_code UNIQUE (code);

CREATE INDEX idx_cred_templates_category ON credential_templates(category_id) WHERE deleted_at IS NULL;

-- ============================================================
-- Step 3: Credential records — tracking data column
-- ============================================================
ALTER TABLE credentials
  ADD COLUMN IF NOT EXISTS tracking_data JSONB NOT NULL DEFAULT '{}';

-- ============================================================
-- Step 4: Credential requirements — ensure full schema
-- ============================================================
-- If credential_requirements exists, verify columns:
ALTER TABLE credential_requirements
  ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS created_by   INTEGER;

CREATE INDEX idx_cred_req_unit_pos ON credential_requirements(unit_id, position)
  WHERE is_mandatory = true AND is_active = true;
```

**Implementation — seed template field definitions:**

```sql
-- Update existing templates with field definitions and category links
-- (template IDs resolved by name match against existing rows)

-- PASSPORT
UPDATE credential_templates SET
  code = 'PASSPORT',
  category_id = (SELECT id FROM credential_categories WHERE code = 'IDENTITY'),
  field_definitions = '{
    "fields": [
      {"key":"passport_number","label":"Passport Number","type":"text","required":true,"displayOrder":1},
      {"key":"issuing_country","label":"Issuing Country","type":"country","required":true,"displayOrder":2},
      {"key":"issue_date","label":"Issue Date","type":"date","required":true,"isIssueDate":true,"displayOrder":3},
      {"key":"expiry_date","label":"Expiry Date","type":"date","required":true,"isExpiryDate":true,"displayOrder":4}
    ]
  }',
  has_expiry = true, display_order = 1
WHERE name = 'Passport';

-- IQAMA
UPDATE credential_templates SET
  code = 'IQAMA',
  category_id = (SELECT id FROM credential_categories WHERE code = 'IDENTITY'),
  field_definitions = '{
    "fields": [
      {"key":"iqama_number","label":"Iqama Number","type":"text","required":true,"displayOrder":1},
      {"key":"sponsor_name","label":"Sponsor/Employer Name","type":"text","required":true,"displayOrder":2},
      {"key":"issue_date","label":"Issue Date","type":"date","required":true,"isIssueDate":true,"displayOrder":3},
      {"key":"expiry_date_greg","label":"Expiry Date (Gregorian)","type":"date","required":true,"isExpiryDate":true,"displayOrder":4},
      {"key":"expiry_date_hijri","label":"Expiry Date (Hijri)","type":"date_hijri","required":false,"displayOrder":5},
      {"key":"job_title","label":"Job Title","type":"text","required":false,"displayOrder":6}
    ]
  }',
  has_expiry = true, display_order = 2
WHERE name ILIKE '%Iqama%' OR name ILIKE '%Resident ID%';

-- HOSPITAL_ID
UPDATE credential_templates SET
  code = 'HOSPITAL_ID',
  category_id = (SELECT id FROM credential_categories WHERE code = 'IDENTITY'),
  field_definitions = '{
    "fields": [
      {"key":"employee_id_number","label":"Employee ID Number","type":"text","required":true,"displayOrder":1},
      {"key":"department_cost_center","label":"Department/Cost Center","type":"text","required":false,"displayOrder":2},
      {"key":"issue_date","label":"Issue Date","type":"date","required":true,"isIssueDate":true,"displayOrder":3},
      {"key":"expiry_date","label":"Expiry Date","type":"date","required":true,"isExpiryDate":true,"displayOrder":4}
    ]
  }',
  has_expiry = true, display_order = 3
WHERE name ILIKE '%Hospital ID%';

-- SCFHS
UPDATE credential_templates SET
  code = 'SCFHS',
  category_id = (SELECT id FROM credential_categories WHERE code = 'LICENSURE'),
  field_definitions = '{
    "fields": [
      {"key":"scfhs_reg_number","label":"SCFHS Registration Number","type":"text","required":true,"displayOrder":1},
      {"key":"professional_classification","label":"Professional Classification","type":"select","required":true,"options":["Nurse Technician","Nurse Specialist","Senior Nurse Specialist","Nurse Consultant"],"displayOrder":2},
      {"key":"issue_date","label":"Issue Date","type":"date","required":true,"isIssueDate":true,"displayOrder":3},
      {"key":"expiry_date","label":"Expiry Date","type":"date","required":true,"isExpiryDate":true,"displayOrder":4}
    ]
  }',
  has_expiry = true, display_order = 5
WHERE name ILIKE '%SCFHS%' OR name ILIKE '%Saudi Council%';

-- BLS (representative life support template — same pattern for ACLS, PALS, NRP, BICSL)
UPDATE credential_templates SET
  code = 'BLS',
  category_id = (SELECT id FROM credential_categories WHERE code = 'LIFE_SUPPORT'),
  field_definitions = '{
    "fields": [
      {"key":"certificate_number","label":"Certificate Number","type":"text","required":true,"displayOrder":1},
      {"key":"training_provider","label":"Training Provider","type":"text","required":true,"displayOrder":2},
      {"key":"issue_date","label":"Issue Date","type":"date","required":true,"isIssueDate":true,"displayOrder":3},
      {"key":"expiry_date","label":"Expiry Date","type":"date","required":true,"isExpiryDate":true,"displayOrder":4}
    ]
  }',
  has_expiry = true, display_order = 12
WHERE name = 'BLS';

-- (Same UPDATE pattern applies to ACLS, PALS, NRP, BICSL, Professional License,
-- Employment Contract, Medical Malpractice, Staff Clearance, Core Generic Competency,
-- Unit Specific Competency, Conscious Sedation — each with their specific field definitions)
```

**Implementation — Prisma schema:**

```prisma
model CredentialCategory {
  id           Int                  @id @default(autoincrement())
  code         String               @unique @db.VarChar(20)
  name         String               @db.VarChar(100)
  description  String?
  displayOrder Int                  @default(0) @map("display_order") @db.SmallInt
  isActive     Boolean              @default(true) @map("is_active")
  createdAt    DateTime             @default(now()) @map("created_at")
  updatedAt    DateTime             @default(now()) @map("updated_at")
  deletedAt    DateTime?            @map("deleted_at")
  templates    CredentialTemplate[]

  @@map("credential_categories")
}

model CredentialTemplate {
  id               Int                    @id @default(autoincrement())
  code             String?                @unique @db.VarChar(20)
  name             String                 @db.VarChar(100)
  categoryId       Int?                   @map("category_id")
  fieldDefinitions Json                   @default("{\"fields\":[]}") @map("field_definitions")
  hasExpiry        Boolean                @default(true) @map("has_expiry")
  requiresUpload   Boolean                @default(true) @map("requires_upload")
  gracePeriodDays  Int                    @default(0) @map("grace_period_days")
  displayOrder     Int                    @default(0) @map("display_order") @db.SmallInt
  isActive         Boolean                @default(true) @map("is_active")
  deletedAt        DateTime?              @map("deleted_at")
  category         CredentialCategory?    @relation(fields: [categoryId], references: [id])
  credentials      Credential[]
  requirements     CredentialRequirement[]

  @@map("credential_templates")
}

model CredentialRequirement {
  id          Int                @id @default(autoincrement())
  templateId  Int                @map("template_id")
  unitId      Int                @map("unit_id")
  position    String?            @db.VarChar(20)
  isMandatory Boolean            @default(true) @map("is_mandatory")
  isActive    Boolean            @default(true) @map("is_active")
  createdAt   DateTime           @default(now()) @map("created_at")
  updatedAt   DateTime           @default(now()) @map("updated_at")
  createdBy   Int?               @map("created_by")
  template    CredentialTemplate @relation(fields: [templateId], references: [id])
  unit        NursingUnit        @relation(fields: [unitId], references: [id])

  @@map("credential_requirements")
}
```

**Implementation — CRUD API controllers:**

```typescript
// src/modules/credentials/controllers/categories.controller.ts
@Controller('api/v1/credential-categories')
@UseGuards(AuthGuard, RbacGuard)
export class CredentialCategoriesController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  async list(@Query('includeInactive') includeInactive?: boolean) {
    return this.credentialsService.getCategories({ includeInactive });
  }

  @Post()
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async create(@Body() dto: CreateCategoryDto) {
    return this.credentialsService.createCategory(dto);
  }

  @Put(':code')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async update(@Param('code') code: string, @Body() dto: UpdateCategoryDto) {
    return this.credentialsService.updateCategory(code, dto);
  }

  @Delete(':code')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async delete(@Param('code') code: string) {
    return this.credentialsService.softDeleteCategory(code);
  }
}

// src/modules/credentials/controllers/templates.controller.ts
@Controller('api/v1/credential-templates')
@UseGuards(AuthGuard, RbacGuard)
export class CredentialTemplatesController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  async list(
    @Query('categoryCode') categoryCode?: string,
    @Query('includeInactive') includeInactive?: boolean,
  ) {
    return this.credentialsService.getTemplates({ categoryCode, includeInactive });
  }

  @Get(':id')
  async getById(@Param('id') id: number) {
    return this.credentialsService.getTemplateById(id);
  }

  @Post()
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async create(@Body() dto: CreateTemplateDto) {
    return this.credentialsService.createTemplate(dto);
  }

  @Put(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async update(@Param('id') id: number, @Body() dto: UpdateTemplateDto) {
    return this.credentialsService.updateTemplate(id, dto);
  }

  @Delete(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async delete(@Param('id') id: number) {
    return this.credentialsService.softDeleteTemplate(id);
  }
}

// src/modules/credentials/controllers/requirements.controller.ts
@Controller('api/v1/credential-requirements')
@UseGuards(AuthGuard, RbacGuard)
export class CredentialRequirementsController {
  constructor(private readonly credentialsService: CredentialsService) {}

  @Get()
  async list(
    @Query('unitId') unitId?: number,
    @Query('position') position?: string,
    @Query('templateId') templateId?: number,
  ) {
    return this.credentialsService.getRequirements({ unitId, position, templateId });
  }

  @Post()
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async create(@Body() dto: CreateRequirementDto, @Req() req) {
    return this.credentialsService.createRequirement(dto, req.user.id);
  }

  @Put(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async update(@Param('id') id: number, @Body() dto: UpdateRequirementDto) {
    return this.credentialsService.updateRequirement(id, dto);
  }

  @Delete(':id')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async delete(@Param('id') id: number) {
    return this.credentialsService.deleteRequirement(id);
  }

  @Post('bulk')
  @RequireRole('HR_ADMIN', 'SYSTEM_ADMIN')
  async bulkSet(@Body() dto: BulkRequirementsDto, @Req() req) {
    return this.credentialsService.bulkSetRequirements(dto, req.user.id);
  }
}
```

**Implementation — service methods (key operations):**

```typescript
// src/modules/credentials/credentials.service.ts

// ── Template soft delete with referential safety ──────────
async softDeleteTemplate(id: number): Promise<void> {
  const template = await this.prisma.credentialTemplate.findUnique({
    where: { id },
  });
  if (!template || template.deletedAt) {
    throw new NotFoundException(`Template ${id} not found`);
  }

  const [activeCredentials, activeRequirements] = await Promise.all([
    this.prisma.credential.count({
      where: { templateId: id, validityStatus: { in: ['Valid', 'ExpiringSoon', 'PendingVerification'] } },
    }),
    this.prisma.credentialRequirement.count({
      where: { templateId: id, isMandatory: true, isActive: true },
    }),
  ]);

  const blockers: string[] = [];
  if (activeCredentials > 0) blockers.push(`${activeCredentials} active credential(s)`);
  if (activeRequirements > 0) blockers.push(`${activeRequirements} active requirement rule(s)`);

  if (blockers.length > 0) {
    throw new ConflictException(
      `Cannot delete template: ${blockers.join(', ')} reference it`,
    );
  }

  await this.prisma.$transaction(async (tx) => {
    await tx.credentialTemplate.update({
      where: { id },
      data: { isActive: false, deletedAt: new Date() },
    });
    await this.auditService.logDomainEvent(tx, {
      action: 'CREDENTIAL_TEMPLATE_DELETED',
      resource: 'credential_templates',
      resourceId: String(id),
      changes: { isActive: false, name: template.name },
    });
  });
}

// ── Requirement create with revalidation ──────────────────
async createRequirement(
  dto: CreateRequirementDto,
  actorId: number,
): Promise<CredentialRequirement> {
  // Validate FK references
  const [template, unit] = await Promise.all([
    this.prisma.credentialTemplate.findUnique({ where: { id: dto.templateId } }),
    this.prisma.nursingUnit.findUnique({ where: { id: dto.unitId } }),
  ]);
  if (!template || template.deletedAt) throw new NotFoundException('Template not found');
  if (!unit || unit.deletedAt) throw new NotFoundException('Unit not found');
  if (dto.position) {
    const pos = await this.prisma.positionDirectory.findUnique({ where: { code: dto.position } });
    if (!pos || !pos.isActive) throw new NotFoundException('Position not found or inactive');
  }

  return this.prisma.$transaction(async (tx) => {
    const requirement = await tx.credentialRequirement.create({
      data: {
        templateId: dto.templateId,
        unitId: dto.unitId,
        position: dto.position ?? null,
        isMandatory: dto.isMandatory ?? true,
        createdBy: actorId,
      },
    });

    // If mandatory, revalidate affected employees' future assignments
    if (requirement.isMandatory) {
      await this.revalidateForNewRequirement(tx, requirement);
    }

    await this.auditService.logDomainEvent(tx, {
      action: 'CREDENTIAL_REQUIREMENT_CREATED',
      resource: 'credential_requirements',
      resourceId: String(requirement.id),
      changes: { templateId: dto.templateId, unitId: dto.unitId, position: dto.position },
    });

    return requirement;
  });
}

// ── Requirement delete with revalidation ──────────────────
async deleteRequirement(id: number): Promise<void> {
  const requirement = await this.prisma.credentialRequirement.findUnique({
    where: { id },
  });
  if (!requirement) throw new NotFoundException('Requirement not found');

  await this.prisma.$transaction(async (tx) => {
    await tx.credentialRequirement.delete({ where: { id } });

    // Removing a requirement may change eligibility — revalidate
    await this.revalidateForRemovedRequirement(tx, requirement);

    await this.auditService.logDomainEvent(tx, {
      action: 'CREDENTIAL_REQUIREMENT_DELETED',
      resource: 'credential_requirements',
      resourceId: String(id),
      changes: { templateId: requirement.templateId, unitId: requirement.unitId },
    });
  });
}
```

**Position-specific credential considerations:** New positions introduced by the position directory (Section 3.1.1) require HR to configure mandatory credential requirements before employees are onboarded with those codes. The eligibility engine blocks scheduling when no applicable credential rule exists for a unit/position combination (Section 6.1). Recommended credential configurations:

| Position | Likely mandatory credentials | Notes |
| :--- | :--- | :--- |
| PRACTITIONER | SCFHS (advanced practice), prescribing authority, BLS, ACLS, PALS | Requires hospital policy decision on advanced practice credential scope |
| NS | SCFHS, BLS, ACLS, identity documents | Full clinical credential set — covers multiple units |
| DON / DEPUTY_DON | SCFHS, professional license, identity documents | Non-schedulable — configure for compliance tracking |
| ADMIN | Identity documents only | Non-clinical — no clinical licensure required |
| ACTING_HEAD | Same as HN | Migrate existing AHN credential rules |
| NURSE_EDUCATOR | SCFHS, professional license, teaching certification | Migrate existing CI credential rules |

**SCFHS professional classification tracking:** The SCFHS template includes a `professional_classification` select field with the Saudi Council of Nursing classification ranks:

| Rank | Minimum Qualification | Key Requirements |
| :--- | :--- | :--- |
| Nurse Technician | Diploma in Nursing (2–3 years post-secondary) | Valid home license, internship completion, SCFHS Technician exam |
| Nurse Specialist | BSN or equivalent 4-year nursing degree | 1-year clinical internship, home registration, SNLE exam |
| Senior Nurse Specialist | MSN / MSc or recognized postgraduate diploma | Accredited master's in nursing specialty, documented post-master's clinical practice |
| Nurse Consultant | Doctorate / PhD / DNP or terminal clinical fellowship | 3–5+ years advanced clinical/academic experience, SCFHS evaluation committee review |

**Acceptance criteria for credential catalog CRUD:**

| Criterion | Required evidence |
| :--- | :--- |
| Categories seeded | 5 categories exist with correct codes, names and display order |
| Templates seeded | 16 templates exist with correct field definitions, category links, expiry flags and codes |
| Category CRUD | HR Admin can add, edit and soft-delete categories; delete blocked when active templates exist |
| Template CRUD | HR Admin can add, edit and soft-delete templates; delete blocked when active credentials or requirements reference it |
| Template list | `GET /api/v1/credential-templates` returns templates grouped by category; filter by `categoryCode` works |
| Field definitions | Template field definitions are stored as JSONB; new templates can define custom fields without code changes |
| Requirement CRUD | HR Admin can add, edit and delete credential requirements; add/delete triggers revalidation |
| Requirement bulk | `POST /api/v1/credential-requirements/bulk` accepts multiple rules in one transaction |
| Expiry tracking | Credentials with `isExpiryDate` fields drive the notification scan (60-day window) and eligibility engine |
| Evidence upload | Employee can upload Image/PDF evidence against any template; upload enters quarantine pipeline |
| Tracking data | Credential records store template-defined field values in `tracking_data` JSONB; fields render dynamically from template definition |
| SCFHS classification | SCFHS template captures Professional Classification as a select field with the 4 Saudi Council ranks |
| Audit trail | All category, template and requirement mutations recorded in domain audit log |

### 5.2 Verification and renewal lifecycle

**Specification:** Verification status is separate from renewal progress. The system tracks both independently.

**Stored validity statuses:** PendingVerification, Valid, ExpiringSoon, Expired, Suspended, Revoked.

**Display lifecycle labels:**

| Lifecycle label | Meaning |
| :--- | :--- |
| Active | Outside the renewal window; valid status and verification still required |
| Subject to Renew | Within 60 days of expiry |
| OnProcess | Replacement data or document is awaiting HR review |
| Expired | Expiry date has passed, even if a replacement is pending |

The lifecycle label alone never authorizes scheduling — verification and date checks still apply.

**Renewal rules:**

- An unexpired, verified credential remains usable during renewal until its actual expiry or an explicit suspension/revocation.
- Replacement fields are staged in pending data. Uploads add document versions and preserve the current approved evidence.
- Approval promotes reviewed data and the selected pending document.
- **Reject renewal** rejects pending evidence and clears staged changes without changing the approved credential.
- Suspension/revocation is a separate validity decision and invalidates eligibility immediately.

**Document history and access:**

- Document history includes version metadata and scoped downloads.
- Employees access their own evidence; scoped HR/System Admin review it.
- Supervisors receive compliance data without private identity numbers, pending field values or document downloads.
- Application APIs do not overwrite historical attachment bytes.
- Database administrators remain privileged custodians; this is not a claim of storage immutability against database-owner access.

### 5.3 Document storage and upload quarantine

**Specification:** The current implementation stores versioned attachment bytes in PostgreSQL. This is acceptable for a controlled pilot with measured storage and backup volume. All uploaded evidence passes through a quarantine-and-scan pipeline before it becomes available for review or download. Unscanned or failed files are never exposed to end users.

#### 5.3.1 Object storage migration — planned

When document volume warrants migration from PostgreSQL BLOBs:

- Introduce a `StorageAdapter` interface and migrate bytes to hospital-approved private object storage.
- Keep document ownership, version, object key, checksum, size, content type, review status and scan result in PostgreSQL.
- Preserve existing download APIs and compare checksums during migration before retiring old bytes.
- Never expose a public bucket. Authorization must precede any short-lived download link.

Object storage cannot participate in a PostgreSQL transaction. Track uploads as `PENDING` / `READY` / `FAILED`, finalize the database reference only after verified storage, and reconcile orphaned objects. Backups must preserve database references and matching object versions.

#### 5.3.2 Upload quarantine and scanning

**Specification:** Every file uploaded as credential evidence enters a quarantine state where it undergoes size validation, content-type verification and malware scanning before being released for review. Files that fail any check remain quarantined and are never served to users.

**Quarantine pipeline:**

```mermaid
flowchart LR
    U[Nurse uploads file] --> V{Size + type\nvalidation}
    V -->|Fail| REJ[REJECTED\nnotify uploader]
    V -->|Pass| Q[(Quarantine\nstorage)]
    Q --> SCAN{ClamAV\nmalware scan}
    SCAN -->|Clean| CLEAN[(Clean storage\nstatus = CLEAN)]
    SCAN -->|Infected| INF[INFECTED\nalert + delete]
    SCAN -->|Error| RETRY{Retry\n≤ 3 attempts}
    RETRY -->|Exhausted| FAIL[SCAN_FAILED\nalert ops]
    RETRY -->|Retry| SCAN
    CLEAN --> REV[Available for\nHR review]
```

**Database schema — upload scan tracking:**

```sql
-- prisma/migrations/V32_upload_quarantine_scan.sql
-- Extends the existing credential_evidence table (or equivalent attachment table)
-- with quarantine tracking columns

ALTER TABLE credential_evidence
  ADD COLUMN scan_status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (scan_status IN ('PENDING', 'SCANNING', 'CLEAN', 'INFECTED', 'SCAN_FAILED', 'REJECTED')),
  ADD COLUMN scan_started_at TIMESTAMPTZ,
  ADD COLUMN scan_completed_at TIMESTAMPTZ,
  ADD COLUMN scan_engine_version TEXT,
  ADD COLUMN scan_signature_version TEXT,
  ADD COLUMN scan_result_detail TEXT,            -- e.g. malware name if infected
  ADD COLUMN scan_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN quarantine_key TEXT,                -- storage key in quarantine area
  ADD COLUMN content_type_detected TEXT,         -- actual detected MIME vs. declared
  ADD COLUMN file_hash_sha256 TEXT;              -- SHA-256 of uploaded bytes

-- Index for the scan worker to find pending files
CREATE INDEX idx_evidence_scan_pending
  ON credential_evidence (scan_status, created_at)
  WHERE scan_status IN ('PENDING', 'SCANNING');

-- Quarantine scan log for audit trail
CREATE TABLE quarantine_scan_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  evidence_id     BIGINT NOT NULL REFERENCES credential_evidence(id),
  action          TEXT NOT NULL CHECK (action IN (
                    'UPLOAD_RECEIVED', 'VALIDATION_PASSED', 'VALIDATION_FAILED',
                    'SCAN_STARTED', 'SCAN_CLEAN', 'SCAN_INFECTED', 'SCAN_ERROR',
                    'SCAN_RETRY', 'RELEASED', 'DELETED'
                  )),
  detail          TEXT,
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_quarantine_log_evidence
  ON quarantine_scan_log (evidence_id, performed_at);
```

**Upload validation rules:**

| Check | Rule | On failure |
| :--- | :--- | :--- |
| File size | Maximum 10 MB per file (configurable via `UPLOAD_MAX_SIZE_BYTES`) | 413 Payload Too Large; `scan_status` = `REJECTED` |
| Content-type allowlist | `application/pdf`, `image/jpeg`, `image/png`, `image/webp` only | 415 Unsupported Media Type; `scan_status` = `REJECTED` |
| Magic bytes verification | Detected MIME type (via `file-type` / libmagic) must match declared `Content-Type` | `scan_status` = `REJECTED`; log mismatch |
| Filename sanitization | Strip path separators, null bytes, control characters; limit to 255 characters | Sanitize silently; reject if empty after sanitization |
| SHA-256 hash | Computed on upload; stored for deduplication and integrity verification | Informational — always computed |

**Implementation — QuarantineService:**

```typescript
@Injectable()
export class QuarantineService {
  private readonly maxFileSize: number;
  private readonly allowedTypes = new Set([
    'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanService: MalwareScanService,
    private readonly storageAdapter: StorageAdapter,
    private readonly config: ConfigService,
  ) {
    this.maxFileSize = this.config.get<number>(
      'UPLOAD_MAX_SIZE_BYTES', 10 * 1024 * 1024,
    );
  }

  /**
   * Receive an uploaded file: validate, quarantine, queue for scanning.
   * Returns the evidence record ID. File is NOT available for review yet.
   */
  async receiveUpload(
    nurseId: number,
    credentialId: number,
    file: Express.Multer.File,
  ): Promise<{ evidenceId: number; status: string }> {
    // 1. Size check
    if (file.size > this.maxFileSize) {
      throw new PayloadTooLargeException(
        `File exceeds maximum size of ${this.maxFileSize} bytes`,
      );
    }

    // 2. Content-type allowlist
    if (!this.allowedTypes.has(file.mimetype)) {
      throw new UnsupportedMediaTypeException(
        `File type ${file.mimetype} is not allowed`,
      );
    }

    // 3. Magic bytes verification
    const detectedType = await this.detectMimeType(file.buffer);
    if (detectedType && detectedType !== file.mimetype) {
      await this.logQuarantine(null, 'VALIDATION_FAILED',
        `Declared ${file.mimetype} but detected ${detectedType}`);
      throw new UnsupportedMediaTypeException(
        'File content does not match declared content type',
      );
    }

    // 4. Compute SHA-256 hash
    const fileHash = createHash('sha256').update(file.buffer).digest('hex');

    // 5. Store in quarantine area
    const quarantineKey = `quarantine/${randomUUID()}/${this.sanitizeFilename(file.originalname)}`;
    await this.storageAdapter.putQuarantine(quarantineKey, file.buffer);

    // 6. Create evidence record in PENDING state
    const evidence = await this.prisma.credentialEvidence.create({
      data: {
        credential_id: credentialId,
        nurse_id: nurseId,
        original_filename: this.sanitizeFilename(file.originalname),
        content_type: file.mimetype,
        content_type_detected: detectedType,
        size_bytes: file.size,
        file_hash_sha256: fileHash,
        quarantine_key: quarantineKey,
        scan_status: 'PENDING',
        scan_attempts: 0,
      },
    });

    await this.logQuarantine(evidence.id, 'UPLOAD_RECEIVED',
      `${file.size} bytes; SHA-256: ${fileHash}`);
    await this.logQuarantine(evidence.id, 'VALIDATION_PASSED');

    return { evidenceId: evidence.id, status: 'PENDING' };
  }

  private sanitizeFilename(name: string): string {
    return name
      .replace(/[/\\:\0\x01-\x1f]/g, '_')  // strip path separators + control chars
      .replace(/\.{2,}/g, '.')               // collapse consecutive dots
      .slice(0, 255) || 'unnamed';
  }

  private async detectMimeType(buffer: Buffer): Promise<string | null> {
    const { fileTypeFromBuffer } = await import('file-type');
    const result = await fileTypeFromBuffer(buffer);
    return result?.mime ?? null;
  }

  private async logQuarantine(
    evidenceId: number | null, action: string, detail?: string,
  ): Promise<void> {
    if (!evidenceId) return;
    await this.prisma.quarantineScanLog.create({
      data: { evidence_id: evidenceId, action, detail },
    });
  }
}
```

**Implementation — MalwareScanService:**

```typescript
@Injectable()
export class MalwareScanService {
  private clamClient: ClamAVClient;

  constructor(private readonly config: ConfigService) {
    this.clamClient = new ClamAVClient({
      host: this.config.getOrThrow<string>('CLAMAV_HOST'),
      port: this.config.get<number>('CLAMAV_PORT', 3310),
      timeout: this.config.get<number>('CLAMAV_TIMEOUT_MS', 30_000),
    });
  }

  async scanBuffer(buffer: Buffer): Promise<ScanResult> {
    try {
      const result = await this.clamClient.scanBuffer(buffer);
      return {
        clean: result.isClean,
        engineVersion: result.engineVersion,
        signatureVersion: result.signatureVersion,
        detail: result.isClean ? null : result.viruses.join(', '),
      };
    } catch (error) {
      return {
        clean: null,   // null = scan error (distinct from clean/infected)
        engineVersion: null,
        signatureVersion: null,
        detail: `Scan error: ${error.message}`,
      };
    }
  }
}

interface ScanResult {
  clean: boolean | null;       // true = clean, false = infected, null = error
  engineVersion: string | null;
  signatureVersion: string | null;
  detail: string | null;
}
```

**Implementation — QuarantineScanWorker:**

```typescript
@Injectable()
export class QuarantineScanWorker {
  private readonly maxRetries = 3;
  private readonly logger = new Logger(QuarantineScanWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanService: MalwareScanService,
    private readonly storageAdapter: StorageAdapter,
    private readonly notificationService: NotificationService,
  ) {}

  // Runs every 30 seconds; advisory lock 100007 prevents overlap
  @Cron('*/30 * * * * *')
  async processPendingScans(): Promise<void> {
    await this.prisma.$executeRaw`SELECT pg_advisory_lock(100007)`;
    try {
      const pending = await this.prisma.credentialEvidence.findMany({
        where: { scan_status: { in: ['PENDING', 'SCANNING'] } },
        orderBy: { created_at: 'asc' },
        take: 10,
      });

      for (const evidence of pending) {
        await this.scanOne(evidence);
      }
    } finally {
      await this.prisma.$executeRaw`SELECT pg_advisory_unlock(100007)`;
    }
  }

  private async scanOne(evidence: CredentialEvidence): Promise<void> {
    // Mark as scanning
    await this.prisma.credentialEvidence.update({
      where: { id: evidence.id },
      data: {
        scan_status: 'SCANNING',
        scan_started_at: new Date(),
        scan_attempts: { increment: 1 },
      },
    });
    await this.logAction(evidence.id, 'SCAN_STARTED');

    // Retrieve file from quarantine
    const buffer = await this.storageAdapter.getQuarantine(
      evidence.quarantine_key,
    );

    // Scan with ClamAV
    const result = await this.scanService.scanBuffer(buffer);

    if (result.clean === true) {
      // Move from quarantine to clean storage
      const cleanKey = evidence.quarantine_key.replace('quarantine/', 'clean/');
      await this.storageAdapter.moveToClean(
        evidence.quarantine_key, cleanKey,
      );

      await this.prisma.credentialEvidence.update({
        where: { id: evidence.id },
        data: {
          scan_status: 'CLEAN',
          scan_completed_at: new Date(),
          scan_engine_version: result.engineVersion,
          scan_signature_version: result.signatureVersion,
          quarantine_key: null,  // no longer in quarantine
          // storage_key = cleanKey (set via storage adapter)
        },
      });
      await this.logAction(evidence.id, 'SCAN_CLEAN');
      await this.logAction(evidence.id, 'RELEASED',
        `Moved to clean storage: ${cleanKey}`);

    } else if (result.clean === false) {
      // Infected — delete from quarantine, alert
      await this.storageAdapter.deleteQuarantine(evidence.quarantine_key);
      await this.prisma.credentialEvidence.update({
        where: { id: evidence.id },
        data: {
          scan_status: 'INFECTED',
          scan_completed_at: new Date(),
          scan_engine_version: result.engineVersion,
          scan_signature_version: result.signatureVersion,
          scan_result_detail: result.detail,
          quarantine_key: null,
        },
      });
      await this.logAction(evidence.id, 'SCAN_INFECTED', result.detail);
      await this.logAction(evidence.id, 'DELETED', 'Infected file removed');
      await this.notificationService.notifyMalwareDetected(evidence);

    } else {
      // Scan error — retry or fail
      const attempts = evidence.scan_attempts + 1;
      if (attempts >= this.maxRetries) {
        await this.prisma.credentialEvidence.update({
          where: { id: evidence.id },
          data: {
            scan_status: 'SCAN_FAILED',
            scan_completed_at: new Date(),
            scan_result_detail: result.detail,
          },
        });
        await this.logAction(evidence.id, 'SCAN_ERROR',
          `Final failure after ${attempts} attempts: ${result.detail}`);
        this.logger.error(
          `Scan permanently failed for evidence ${evidence.id}`,
        );
      } else {
        await this.prisma.credentialEvidence.update({
          where: { id: evidence.id },
          data: { scan_status: 'PENDING' },  // re-queue
        });
        await this.logAction(evidence.id, 'SCAN_RETRY',
          `Attempt ${attempts}: ${result.detail}`);
      }
    }
  }

  private async logAction(
    evidenceId: number, action: string, detail?: string,
  ): Promise<void> {
    await this.prisma.quarantineScanLog.create({
      data: { evidence_id: evidenceId, action, detail },
    });
  }
}
```

**Download authorization enforcement:**

```typescript
// In the evidence download controller — enforce quarantine gate
@Get(':evidenceId/download')
@UseGuards(JwtAuthGuard, ScopeGuard)
async downloadEvidence(
  @Param('evidenceId', ParseIntPipe) evidenceId: number,
  @CurrentUser() user: AuthUser,
): Promise<StreamableFile> {
  const evidence = await this.prisma.credentialEvidence.findUniqueOrThrow({
    where: { id: evidenceId },
  });

  // CRITICAL: Only CLEAN files can be downloaded
  if (evidence.scan_status !== 'CLEAN') {
    throw new ForbiddenException(
      `Evidence is not available for download (status: ${evidence.scan_status})`,
    );
  }

  // ... existing authorization and streaming logic
}
```

**Environment configuration:**

```bash
# Upload quarantine settings
UPLOAD_MAX_SIZE_BYTES=10485760           # 10 MB
CLAMAV_HOST=clamav.internal              # ClamAV daemon host
CLAMAV_PORT=3310                         # ClamAV daemon port (clamd)
CLAMAV_TIMEOUT_MS=30000                  # Scan timeout per file
QUARANTINE_STORAGE_PATH=/data/quarantine # Quarantine area (separate from clean)
CLEAN_STORAGE_PATH=/data/evidence        # Clean evidence storage
```

**Rules:**

1. Every uploaded file begins in `PENDING` status and is stored in quarantine. No file reaches `CLEAN` status without passing both validation and malware scanning.
2. Files with `scan_status` other than `CLEAN` cannot be downloaded, previewed, or approved by HR. The download endpoint enforces this as a hard gate.
3. Infected files are immediately deleted from quarantine storage. The database record is preserved with `INFECTED` status for audit purposes.
4. Scan failures are retried up to 3 times. After exhaustion, the file remains quarantined with `SCAN_FAILED` status and an operations alert is raised.
5. The quarantine scan worker acquires the `quarantine.scan` worker lease (Section 10.3, V49) so only one worker scans at a time; if the worker dies mid-scan the lease expires and the file is re-scanned by the next run.
6. Magic bytes verification catches content-type spoofing (e.g. an executable disguised as a PDF). Both declared and detected MIME types are recorded.
7. ClamAV signature database must be updated at least daily via `freshclam`. Stale signatures (> 48 hours) should trigger an operations alert.

**Acceptance criteria for upload quarantine and scanning:**

| Criterion | Required evidence |
| :--- | :--- |
| Quarantine gate | Uploaded file with `PENDING` or `SCANNING` status returns 403 on download attempt |
| Clean release | File passing ClamAV scan transitions to `CLEAN` and becomes downloadable |
| Infected detection | EICAR test file is detected as infected; file is deleted from storage; alert fires |
| Content-type enforcement | File with mismatched magic bytes (e.g. `.exe` renamed to `.pdf`) is rejected at upload |
| Size enforcement | File exceeding `UPLOAD_MAX_SIZE_BYTES` returns 413 before quarantine storage |
| Retry logic | Simulated ClamAV timeout retries up to 3 times; fourth attempt sets `SCAN_FAILED` |
| Existing evidence safe | Currently approved evidence (uploaded before quarantine was enabled) remains downloadable |
| Audit trail | `quarantine_scan_log` contains entries for every state transition |
| Advisory lock | Two concurrent worker instances do not scan the same file simultaneously |

**Implementation — secure evidence vault download (signed URLs):**

```typescript
// src/modules/credentials/evidence.controller.ts

@Get(':evidenceId/download')
@UseGuards(JwtAuthGuard, ScopeGuard) // RBAC check
async downloadEvidence(
  @Param('evidenceId', ParseIntPipe) evidenceId: number,
  @CurrentUser() user: AuthUser,
) {
  const evidence = await this.prisma.credentialEvidence.findUniqueOrThrow({
    where: { id: evidenceId },
  });

  // 1. RBAC Validation (Is the user allowed to see this specific nurse's file?)
  await this.scopeGuard.verifyAccess(user, evidence.nurse_id, 'READ_EVIDENCE');

  // 2. Zero Direct Access: Generate a temporary Signed URL
  // The file is in a private bucket; this URL expires in 30 seconds.
  const signedUrl = await this.storageProvider.generateSignedUrl(
    evidence.storage_key,
    { expiresIn: 30 }
  );

  // 3. Redirect the user to the temporary secure link
  return this.response.redirect(signedUrl);
}
```

**Implementation — evidence integrity & cleanup worker:**

```typescript
// src/modules/credentials/evidence-cleanup.worker.ts
@Injectable()
export class EvidenceCleanupWorker {

  // 1. Tamper Detection: Verify checksums of randomly selected files
  @Cron('0 0 * * 0') // Weekly on Sunday
  async verifyIntegrity() {
    const samples = await this.prisma.credentialEvidence.findMany({ take: 100 });
    for (const file of samples) {
      const currentHash = await this.storageProvider.calculateHash(file.storage_key);
      if (currentHash !== file.file_checksum) {
        await this.alertAuditor(`Tampering detected in file ${file.id}`);
      }
    }
  }

  // 2. Garbage Collection: Delete orphaned files from S3/Disk
  @Cron('0 2 * * *') // Nightly at 02:00
  async cleanupOrphans() {
    const storageFiles = await this.storageProvider.listAllFiles();
    const dbFiles = await this.prisma.credentialEvidence.findMany({
      select: { storage_key: true }
    });
    const dbSet = new Set(dbFiles.map(f => f.storage_key));

    for (const file of storageFiles) {
      if (!dbSet.has(file)) {
        await this.storageProvider.deleteFile(file);
        this.logger.log(`Deleted orphaned evidence file: ${file}`);
      }
    }
  }
}
```

### 5.4 SCFHS credential verification integration

**Specification:** The system integrates with the Saudi Council for Health Specialties (SCFHS) electronic verification service to automate professional license validation, reducing manual HR workload and catching revocations or status changes that might otherwise be missed.

**Integration scope:**

| Capability | Description |
| :--- | :--- |
| License verification | Query SCFHS by practitioner registration number to confirm license validity, specialty, expiry date and disciplinary status |
| Automated sync | Nightly scheduled sync updates all active nurse credentials of type `SCFHS` against the council's records |
| Event-driven verification | On-demand verification triggered during credential submission, renewal approval and eligibility checks |
| Status change detection | Detect revocations, suspensions or expiry changes published by SCFHS between renewal cycles |

**Architecture:**

```mermaid
flowchart LR
    subgraph NurseApp
        CS[Credentials Service] --> SI[SCFHS Integration Service]
        NW[Notification Worker] --> SI
        EL[Eligibility Service] --> SI
    end
    SI -->|HTTPS / mTLS| GW[SCFHS API Gateway]
    GW --> SCFHS[(SCFHS Verification Service)]
    SI --> VL[(scfhs_verification_log)]
```

**Implementation — database schema:**

```sql
-- prisma/migrations/V30_scfhs_integration.sql

-- Verification attempt log — every call to SCFHS is recorded
CREATE TABLE scfhs_verification_log (
  id                BIGSERIAL PRIMARY KEY,
  credential_id     INTEGER NOT NULL REFERENCES credentials(id),
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  scfhs_reg_number  VARCHAR(50) NOT NULL,
  request_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  response_timestamp TIMESTAMPTZ,
  request_type      VARCHAR(30) NOT NULL,          -- 'MANUAL', 'SCHEDULED', 'ON_SUBMIT', 'ELIGIBILITY'
  response_status   VARCHAR(30),                   -- 'VERIFIED', 'EXPIRED', 'SUSPENDED', 'REVOKED', 'NOT_FOUND', 'ERROR'
  scfhs_expiry_date DATE,                          -- expiry date returned by SCFHS
  scfhs_specialty   VARCHAR(200),                  -- specialty returned by SCFHS
  scfhs_license_status VARCHAR(50),                -- raw status from SCFHS response
  raw_response_hash VARCHAR(64),                   -- SHA-256 of full response (never store PII in clear)
  error_message     VARCHAR(500),                  -- NULL on success; error detail on failure
  matched           BOOLEAN,                       -- does SCFHS data match local credential?
  discrepancy_notes TEXT,                           -- human-readable description of mismatches
  actor_id          INTEGER,                       -- NULL for scheduled; user ID for manual
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_svl_credential ON scfhs_verification_log(credential_id, request_timestamp DESC);
CREATE INDEX idx_svl_employee   ON scfhs_verification_log(employee_id, request_timestamp DESC);
CREATE INDEX idx_svl_status     ON scfhs_verification_log(response_status) WHERE response_status IN ('SUSPENDED', 'REVOKED');

-- SCFHS integration configuration per credential template
ALTER TABLE credential_templates
  ADD COLUMN scfhs_enabled          BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN scfhs_auto_suspend     BOOLEAN NOT NULL DEFAULT false,  -- auto-suspend on REVOKED/SUSPENDED
  ADD COLUMN scfhs_sync_priority    INTEGER NOT NULL DEFAULT 0;      -- 0 = standard nightly; 1 = high-frequency
```

**Implementation — integration service:**

```typescript
// src/modules/credentials/scfhs/scfhs-integration.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { PrismaService } from '../../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { createHash } from 'crypto';

export interface ScfhsVerificationResult {
  status: 'VERIFIED' | 'EXPIRED' | 'SUSPENDED' | 'REVOKED' | 'NOT_FOUND' | 'ERROR';
  expiryDate: Date | null;
  specialty: string | null;
  licenseStatus: string | null;
  matched: boolean;
  discrepancies: string[];
}

@Injectable()
export class ScfhsIntegrationService {
  private readonly logger = new Logger(ScfhsIntegrationService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Verify a single credential against SCFHS.
   * Called on-demand (manual review, submission, eligibility) or by the nightly sync.
   */
  async verifyCredential(
    credentialId: number,
    employeeId: number,
    scfhsRegNumber: string,
    requestType: 'MANUAL' | 'SCHEDULED' | 'ON_SUBMIT' | 'ELIGIBILITY',
    actorId?: number,
  ): Promise<ScfhsVerificationResult> {
    const requestTimestamp = new Date();

    try {
      // Call SCFHS API with mTLS
      const response = await this.callScfhsApi(scfhsRegNumber);
      const responseTimestamp = new Date();

      // Compare SCFHS response against local credential data
      const localCredential = await this.prisma.credential.findUnique({
        where: { id: credentialId },
      });

      const discrepancies: string[] = [];
      let matched = true;

      if (response.expiryDate && localCredential?.expiryDate) {
        const scfhsExpiry = new Date(response.expiryDate);
        const localExpiry = new Date(localCredential.expiryDate);
        if (scfhsExpiry.getTime() !== localExpiry.getTime()) {
          discrepancies.push(
            `Expiry mismatch: local=${localExpiry.toISOString().split('T')[0]}, ` +
            `SCFHS=${scfhsExpiry.toISOString().split('T')[0]}`
          );
          matched = false;
        }
      }

      if (response.specialty && localCredential?.specialty) {
        if (response.specialty !== localCredential.specialty) {
          discrepancies.push(
            `Specialty mismatch: local=${localCredential.specialty}, SCFHS=${response.specialty}`
          );
          matched = false;
        }
      }

      // Log the verification attempt
      await this.prisma.scfhsVerificationLog.create({
        data: {
          credentialId,
          employeeId,
          scfhsRegNumber,
          requestTimestamp,
          responseTimestamp,
          requestType,
          responseStatus: response.status,
          scfhsExpiryDate: response.expiryDate,
          scfhsSpecialty: response.specialty,
          scfhsLicenseStatus: response.licenseStatus,
          rawResponseHash: this.hashResponse(response.rawBody),
          matched,
          discrepancyNotes: discrepancies.length > 0
            ? discrepancies.join('; ')
            : null,
          actorId: actorId ?? null,
        },
      });

      // Auto-suspend if SCFHS reports revocation/suspension and template allows it
      if (['REVOKED', 'SUSPENDED'].includes(response.status)) {
        await this.handleAdverseStatus(credentialId, employeeId, response.status, actorId);
      }

      // Auto-update expiry date if SCFHS reports a different date
      if (!matched && response.expiryDate && response.status === 'VERIFIED') {
        await this.flagExpiryDiscrepancy(credentialId, employeeId, response.expiryDate);
      }

      return {
        status: response.status,
        expiryDate: response.expiryDate,
        specialty: response.specialty,
        licenseStatus: response.licenseStatus,
        matched,
        discrepancies,
      };
    } catch (error) {
      this.logger.error(
        `SCFHS verification failed for credential ${credentialId}: ${error.message}`,
      );

      // Log the failed attempt
      await this.prisma.scfhsVerificationLog.create({
        data: {
          credentialId,
          employeeId,
          scfhsRegNumber,
          requestTimestamp,
          requestType,
          responseStatus: 'ERROR',
          errorMessage: error.message?.substring(0, 500),
          matched: false,
          actorId: actorId ?? null,
        },
      });

      return {
        status: 'ERROR',
        expiryDate: null,
        specialty: null,
        licenseStatus: null,
        matched: false,
        discrepancies: [`Verification failed: ${error.message}`],
      };
    }
  }

  /**
   * Handle SCFHS-reported revocation or suspension.
   * If the credential template has scfhs_auto_suspend enabled,
   * immediately suspend the credential and trigger eligibility revalidation.
   */
  private async handleAdverseStatus(
    credentialId: number,
    employeeId: number,
    scfhsStatus: string,
    actorId?: number,
  ) {
    const credential = await this.prisma.credential.findUnique({
      where: { id: credentialId },
      include: { template: true },
    });

    if (!credential?.template?.scfhsAutoSuspend) {
      // Template does not allow auto-suspend — flag for manual HR review
      this.logger.warn(
        `SCFHS reports ${scfhsStatus} for credential ${credentialId} — ` +
        `auto-suspend disabled; creating HR notification`,
      );
      await this.createAdverseStatusNotification(credentialId, employeeId, scfhsStatus);
      return;
    }

    // Auto-suspend the credential within a transaction (with audit)
    await this.prisma.$transaction(async (tx) => {
      await tx.credential.update({
        where: { id: credentialId },
        data: {
          validityStatus: scfhsStatus === 'REVOKED' ? 'Revoked' : 'Suspended',
          scfhsLastVerified: new Date(),
        },
      });

      await this.auditService.recordDomainEvent(tx, {
        action: 'CREDENTIAL_SCFHS_AUTO_SUSPEND',
        resourceType: 'credential',
        resourceId: credentialId,
        actorId: actorId ?? null,
        changes: { validityStatus: scfhsStatus === 'REVOKED' ? 'Revoked' : 'Suspended' },
        reason: `SCFHS verification returned ${scfhsStatus}`,
      });
    });

    // Trigger eligibility revalidation for future published assignments
    await this.createAdverseStatusNotification(credentialId, employeeId, scfhsStatus);
  }

  private async callScfhsApi(regNumber: string): Promise<any> {
    const response = await this.httpService.axiosRef.post(
      process.env.SCFHS_API_URL!,
      { registrationNumber: regNumber },
      {
        httpsAgent: this.getMtlsAgent(),
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': process.env.SCFHS_API_KEY,
        },
        timeout: 30_000, // 30-second timeout
      },
    );
    return this.mapScfhsResponse(response.data);
  }

  private hashResponse(rawBody: string): string {
    return createHash('sha256').update(rawBody).digest('hex');
  }

  // ... getMtlsAgent(), mapScfhsResponse(), createAdverseStatusNotification(),
  //     flagExpiryDiscrepancy() implementations
}
```

**Implementation — resilient gateway pattern:**

```typescript
// src/modules/credentials/scfhs/scfhs-resilience.service.ts
@Injectable()
export class ScfhsResilienceService {
  constructor(private readonly prisma: PrismaService) {}

  async checkCircuitBreaker(): Promise<boolean> {
    const health = await this.prisma.externalApiHealth.findUnique({
      where: { api_name: 'SCFHS' }
    });

    if (!health.is_available) {
      // Check if recovery time has passed
      if (new Date() > health.recovery_time) {
        await this.resetCircuit();
        return true;
      }
      return false; // Circuit is OPEN (API is blocked)
    }
    return true;
  }

  async recordFailure() {
    await this.prisma.externalApiHealth.update({
      where: { api_name: 'SCFHS' },
      data: {
        failure_count: { increment: 1 },
        last_failure_at: new Date(),
      }
    });

    // Trip the circuit after 5 consecutive failures
    const health = await this.prisma.externalApiHealth.findUnique({ where: { api_name: 'SCFHS' } });
    if (health.failure_count >= 5) {
      await this.prisma.externalApiHealth.update({
        where: { api_name: 'SCFHS' },
        data: {
          is_available: false,
          recovery_time: new Date(Date.now() + 15 * 60 * 1000) // Block for 15 mins
        }
      });
    }
  }

  async resetCircuit() {
    await this.prisma.externalApiHealth.update({
      where: { api_name: 'SCFHS' },
      data: { is_available: true, failure_count: 0 }
    });
  }
}
```
```

**Implementation — nightly sync worker:**

```typescript
// src/modules/credentials/scfhs/scfhs-sync.worker.ts
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../../prisma/prisma.service';
import { ScfhsIntegrationService } from './scfhs-integration.service';

const SCFHS_SYNC_LOCK_ID = 100003;

@Injectable()
export class ScfhsSyncWorker {
  private readonly logger = new Logger(ScfhsSyncWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly scfhsService: ScfhsIntegrationService,
  ) {}

  /**
   * Nightly sync at 02:00 Asia/Riyadh (23:00 UTC previous day).
   * Runs AFTER midnight date transition, BEFORE the 06:00 notification scan.
   */
  @Cron('0 23 * * *')
  async nightlyScfhsSync() {
    const acquired = await this.tryLock(SCFHS_SYNC_LOCK_ID);
    if (!acquired) return;

    try {
      this.logger.log('Starting nightly SCFHS credential sync');

      // Fetch all active SCFHS-enabled credentials for active employees
      const credentials = await this.prisma.$queryRaw`
        SELECT c.id AS credential_id,
               c.employee_id,
               c.scfhs_reg_number,
               ct.scfhs_sync_priority
        FROM credentials c
        JOIN credential_templates ct ON c.template_id = ct.id
        JOIN employees e ON c.employee_id = e.id
        WHERE ct.scfhs_enabled = true
          AND c.validity_status IN ('Valid', 'ExpiringSoon')
          AND e.status = 'Active'
          AND e.deleted_at IS NULL
        ORDER BY ct.scfhs_sync_priority DESC, c.expiry_date ASC
      `;

      let verified = 0;
      let failed = 0;
      let adverse = 0;

      for (const cred of credentials as any[]) {
        // Rate-limit: max 2 requests per second to avoid overwhelming SCFHS
        await this.delay(500);

        const result = await this.scfhsService.verifyCredential(
          cred.credential_id,
          cred.employee_id,
          cred.scfhs_reg_number,
          'SCHEDULED',
        );

        if (result.status === 'ERROR') {
          failed++;
        } else if (['SUSPENDED', 'REVOKED'].includes(result.status)) {
          adverse++;
          verified++;
        } else {
          verified++;
        }
      }

      this.logger.log(
        `SCFHS sync complete: ${verified} verified, ${failed} failed, ${adverse} adverse`,
      );
    } finally {
      await this.releaseLock(SCFHS_SYNC_LOCK_ID);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // SUPERSEDED (2.8.7): session-scoped advisory locks — safe only on a
  // single dedicated connection. Migrate to WorkerLeaseService.withLease (V49).
  private async tryLock(lockId: number): Promise<boolean> {
    const result = await this.prisma.$queryRaw`
      SELECT pg_try_advisory_lock(${lockId}) AS acquired
    `;
    return (result as any[])[0].acquired;
  }

  private async releaseLock(lockId: number) {
    await this.prisma.$queryRaw`SELECT pg_advisory_unlock(${lockId})`;
  }
}
```

**Implementation — job-based sync worker:**

```typescript
// src/modules/credentials/scfhs/scfhs-sync.worker.ts

@Cron('0 23 * * *') // 23:00 UTC
async nightlyScfhsSync() {
  const acquired = await this.tryLock(SCFHS_SYNC_LOCK_ID);
  if (!acquired) return;

  try {
    // 1. Identify all credentials that need syncing
    const targetCredentials = await this.prisma.credential.findMany({
      where: { template: { scfhs_enabled: true } },
      select: { id: true }
    });

    // 2. Dispatch individual jobs to a queue (e.g., BullMQ)
    // This prevents a single failure from crashing the entire sync
    for (const cred of targetCredentials) {
      await this.syncQueue.add('verify-credential',
        { credentialId: cred.id },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 }
        }
      );
    }

    this.logger.log(`Dispatched ${targetCredentials.length} verification jobs.`);
  } finally {
    await this.releaseLock(SCFHS_SYNC_LOCK_ID);
  }
}

// Job Processor (Runs concurrently)
async processVerificationJob(job: Job) {
  if (!(await this.resilience.checkCircuitBreaker())) {
    throw new Error('SCFHS_API_CIRCUIT_OPEN'); // Re-queue job for later
  }

  try {
    await this.scfhsService.verifyCredential(job.data.credentialId, ...);
    await this.resilience.resetCircuit(); // Success! Reset failure count
  } catch (error) {
    await this.resilience.recordFailure();
    throw error; // Trigger exponential backoff
  }
}
```
```

**Implementation — environment configuration:**

```env
# .env.production — SCFHS integration section
SCFHS_API_URL=https://api.scfhs.org.sa/v1/verify    # SCFHS verification endpoint
SCFHS_API_KEY=${SCFHS_API_SECRET}                    # from deployment secrets
SCFHS_CLIENT_CERT_PATH=/etc/ssl/scfhs/client.pem     # mTLS client certificate
SCFHS_CLIENT_KEY_PATH=/etc/ssl/scfhs/client-key.pem  # mTLS client private key
SCFHS_CA_CERT_PATH=/etc/ssl/scfhs/scfhs-ca.pem       # SCFHS CA bundle
SCFHS_TIMEOUT_MS=30000                               # per-request timeout
SCFHS_RATE_LIMIT_RPS=2                               # max requests per second
```

**SCFHS integration rules:**

- Verification is **supplementary** — it enriches and validates credential data but does not replace the HR review workflow. An SCFHS "VERIFIED" response does not auto-approve a credential submission; HR must still review evidence.
- Revocation/suspension responses **can** auto-suspend the local credential when `scfhs_auto_suspend` is enabled on the template — this is the one case where SCFHS data directly affects eligibility without HR intervention.
- Every API call is logged in `scfhs_verification_log` regardless of outcome. Failed calls are retried in the next nightly sync, not immediately.
- SCFHS API unavailability does not block credential operations. The system falls back to manual verification with a dashboard warning that SCFHS sync is stale.
- The raw SCFHS response is never stored in clear text — only a SHA-256 hash for reconciliation. Mapped fields (expiry, specialty, status) are stored individually.
- The nightly sync runs at 02:00 Asia/Riyadh (23:00 UTC), after midnight date transitions and before the 06:00 notification scan, so that any status changes detected by SCFHS are reflected before expiry notifications are generated.
- **Stale-data grace** — if the SCFHS API is unreachable or the circuit breaker is OPEN, the system marks the affected credentials as `sync_status = 'STALE'`.
- **Continuity rule** — a STALE credential does not immediately block eligibility. The nurse remains eligible for a 48-hour grace window from the last successful sync timestamp, ensuring that government API downtime does not cause a total hospital staffing collapse.
- **Escalation** — if the `sync_status` remains STALE or FAILED for more than 48 hours, the credential is marked Expired and eligibility is revoked.

**Acceptance criteria for SCFHS integration:**

| Criterion | Required evidence |
| :--- | :--- |
| API connectivity | mTLS handshake succeeds against SCFHS staging endpoint; timeout and retry behavior verified |
| Verification accuracy | Manual verification of 10+ credentials matches SCFHS portal lookup |
| Auto-suspend | A credential with `scfhs_auto_suspend=true` is suspended within one sync cycle after SCFHS reports REVOKED; eligibility engine reflects the change |
| Discrepancy detection | Expiry date mismatch between local and SCFHS records creates an HR notification |
| Sync resilience | SCFHS unavailability does not block credential operations; next sync catches up |
| Audit completeness | Every verification attempt (success and failure) has a `scfhs_verification_log` entry |
| Rate limiting | Nightly sync respects the configured rate limit; no SCFHS throttling errors |
| Fallback | Credential review, submission and eligibility continue normally when SCFHS is unreachable |

---

## 6. Roster eligibility and publication

### 6.1 Eligibility engine

**Specification:** One canonical eligibility implementation determines whether a nurse can be scheduled. The same database function and application service are used for available-nurse pool queries, assignment checks at draft time, publication validation, and revalidation when credentials, contracts or status change.

To ensure high performance and prevent race conditions during roster publication, the system uses a **Materialized Eligibility State**. Instead of calculating eligibility on every request, the system stores the current result in the `employee_eligibility_state` table (see migration V39, Section 10.1).

**State machine flow:**

- **READ path (O(1))** — the Scheduling and Roster modules perform a direct `SELECT` from `employee_eligibility_state`. No complex joins are performed during roster viewing.
- **WRITE path (event-driven)** — the `EligibilityStateService` recalculates and updates the state only when a trigger event occurs:
  - Contract event: approval, termination, or renewal of a contract.
  - Credential event: verification, expiry, or revocation of a mandatory credential.
  - Position event: toggling the `is_schedulable` flag in the position directory.
  - Temporal event: the "Daily Midnight Transition" (triggered via cron) to account for date-based expiries.
- **Consistency guarantee** — handlers that mutate contracts, credentials, position schedulability or waivers call `refreshState(tx, …)` **inside** the same transaction, so the state commits with the trigger event. Scheduled transitions (the daily midnight cron) run after commit and are covered by the consistency auditor (Section 10.8), which is why the auditor exists rather than being redundant.
- **Authoritative source** — the state table is authoritative for pool, roster and dashboard reads. **Publication does not trust the snapshot**: `publishSchedule` re-validates the candidate set against the canonical engine inside the publication transaction (Section 6.2).

**Eligibility checks (in order):**

1. The employee exists, is not deleted and is Active.
2. The employee's position is schedulable (`position_directory.is_schedulable = true`). Non-schedulable positions (DON, DEPUTY_DON, ADMIN) are ineligible for shift assignment regardless of credential status.
3. An Approved or Active contract covers the shift date.
4. Applicable mandatory credential rules exist for the employee's unit/position.
5. Every required template has verified (Valid or ExpiringSoon) evidence, issued by the shift date and not expired on that date — **or** the credential is within its configured grace period and a renewal is in progress (see Section 6.1.1).
6. Service-level caller scope authorizes the nurse and destination unit/post/shift.

If no applicable credential rule is configured for a unit/position, scheduling is blocked with an explanation — the system does not invent requirements, but it also does not silently bypass them.

**Implementation — eligibility state service:**

```typescript
// src/modules/eligibility/eligibility-state.service.ts
@Injectable()
export class EligibilityStateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly engine: EligibilityEngine, // The original check_nurse_eligibility logic
  ) {}

  /**
   * Recalculates and persists the eligibility state for a specific nurse.
   * Called by other services during "Trigger Events".
   */
  async refreshState(
    employeeId: number,
    eventSource: string,
    // Callers inside a business transaction pass their client so the state
    // commits atomically with the trigger event (Section 6.1).
    tx: PrismaTransactionClient = this.prisma,
  ): Promise<void> {
    // 1. Run the heavy canonical calculation
    const result = await this.engine.calculate(employeeId, new Date(), tx);

    // 2. Update the materialized state table on the same client
    await tx.employeeEligibilityState.upsert({
      where: { employee_id: employeeId },
      update: {
        status: result.eligibilityType,
        reasons: result.reasons,
        last_calculated_at: new Date(),
        updated_by_event: eventSource,
      },
      create: {
        employee_id: employeeId,
        status: result.eligibilityType,
        reasons: result.reasons,
        updated_by_event: eventSource,
      },
    });
  }

  /**
   * Bulk refresh for all nurses (triggered by Daily Midnight Cron)
   */
  async refreshAllStates() {
    const employees = await this.prisma.employee.findMany({ where: { deletedAt: null } });
    for (const emp of employees) {
      await this.refreshState(emp.id, 'DAILY_TRANSITION');
    }
  }
}
```

### 6.1.1 Configurable grace periods

**Specification:** Credential templates support an optional grace period that allows a nurse to remain eligible for a bounded number of days after a credential expires, provided a renewal is actively in progress. This reflects Saudi healthcare regulatory practice where practitioners are not immediately removed from duty while a renewal is being processed.

**Rules:**

- Each credential template carries a `grace_period_days` value (default: `0` — no grace). HR configures this per template based on hospital policy and regulatory guidance.
- A grace period applies **only** when all of the following conditions are met:
  - The credential's expiry date has passed.
  - The shift date falls within `expiry_date + grace_period_days` (inclusive).
  - A renewal is in progress — the credential has pending replacement data or a pending document version awaiting HR review (lifecycle label `OnProcess`).
  - The credential has not been explicitly Suspended or Revoked.
- When a grace period applies, the eligibility engine returns `ELIGIBLE_WITH_GRACE` instead of `ELIGIBLE`. The shift assignment, roster view and publication confirmation display a visual indicator that the nurse is scheduled under a grace allowance.
- Grace-period eligibility is **never silent**. Every assignment that relies on a grace period records the fact in the audit trail and generates a dashboard notification for scoped HR users.
- If the renewal is rejected or the grace window expires (whichever comes first), eligibility reverts to ineligible and future published assignments are demoted to draft for review — the same revalidation path as a standard credential expiry.
- Grace periods do not stack. A credential can use at most one grace window per expiry cycle. A second consecutive expiry without a completed renewal is ineligible regardless of configuration.
- Supervisors and HR can see a "Grace Active" indicator on the roster and employee detail views. Employees see a "Renewal Required — Grace Period Active" alert on their dashboard.

**Implementation — database schema:**

```sql
-- prisma/migrations/V31_grace_periods.sql

-- Add grace period configuration to credential templates
ALTER TABLE credential_templates
  ADD COLUMN grace_period_days INTEGER NOT NULL DEFAULT 0
    CONSTRAINT chk_grace_period_range CHECK (grace_period_days >= 0 AND grace_period_days <= 90);

-- Add grace tracking to credentials
ALTER TABLE credentials
  ADD COLUMN grace_activated_at   TIMESTAMPTZ,       -- when grace was first applied
  ADD COLUMN grace_expiry_date    DATE,              -- expiry_date + grace_period_days
  ADD COLUMN grace_cycle_id       UUID;              -- links to the renewal cycle; prevents stacking

-- Grace period audit entries
CREATE TABLE grace_period_log (
  id                BIGSERIAL PRIMARY KEY,
  credential_id     INTEGER NOT NULL REFERENCES credentials(id),
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  template_id       INTEGER NOT NULL REFERENCES credential_templates(id),
  grace_start_date  DATE NOT NULL,                   -- credential expiry date
  grace_end_date    DATE NOT NULL,                   -- expiry + grace_period_days
  grace_cycle_id    UUID NOT NULL,
  status            VARCHAR(30) NOT NULL DEFAULT 'ACTIVE',  -- 'ACTIVE', 'COMPLETED', 'EXPIRED', 'REVOKED'
  activated_by      VARCHAR(30) NOT NULL,            -- 'SYSTEM' (auto) or 'MANUAL' (HR override)
  completed_at      TIMESTAMPTZ,
  completed_reason  VARCHAR(100),                    -- 'RENEWAL_APPROVED', 'GRACE_EXPIRED', 'RENEWAL_REJECTED', 'SUSPENDED', 'REVOKED'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_gpl_credential ON grace_period_log(credential_id, status);
CREATE INDEX idx_gpl_employee   ON grace_period_log(employee_id, status) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX idx_gpl_cycle ON grace_period_log(credential_id, grace_cycle_id);
```

**Implementation — updated eligibility database function:**

```sql
-- Updated canonical eligibility function with grace period support
CREATE OR REPLACE FUNCTION check_nurse_eligibility(
  p_employee_id INTEGER,
  p_shift_date  DATE
)
RETURNS TABLE (
  is_eligible       BOOLEAN,
  eligibility_type  VARCHAR(30),  -- 'ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'INELIGIBLE'
  reasons           TEXT[]
) AS $$
DECLARE
  v_reasons TEXT[] := '{}';
  v_eligible BOOLEAN := true;
  v_grace_applied BOOLEAN := false;
  v_employee RECORD;
BEGIN
  -- Check 1: Employee exists, not deleted, Active
  SELECT INTO v_employee id, status, unit_id, position
  FROM employees
  WHERE id = p_employee_id AND deleted_at IS NULL;

  IF NOT FOUND OR v_employee.status != 'Active' THEN
    RETURN QUERY SELECT false, 'INELIGIBLE'::VARCHAR(30),
      ARRAY['Employee not active or not found']::TEXT[];
    RETURN;
  END IF;

  -- Check 2: Position is schedulable (Section 3.1.1)
  IF NOT EXISTS (
    SELECT 1 FROM position_directory
    WHERE code = v_employee.position
      AND is_schedulable = true
  ) THEN
    RETURN QUERY SELECT false, 'INELIGIBLE'::VARCHAR(30),
      ARRAY['Position ' || v_employee.position || ' is not schedulable']::TEXT[];
    RETURN;
  END IF;

  -- Check 3: Contract coverage
  IF NOT EXISTS (
    SELECT 1 FROM contracts
    WHERE employee_id = p_employee_id
      AND status IN ('Approved', 'Active')
      AND p_shift_date BETWEEN start_date AND end_date
  ) THEN
    v_eligible := false;
    v_reasons := array_append(v_reasons, 'No approved/active contract covers shift date');
  END IF;

  -- Check 3 & 4: Credential requirements with grace period support
  DECLARE
    req RECORD;
  BEGIN
    FOR req IN
      SELECT cr.template_id, ct.name AS template_name,
             ct.grace_period_days
      FROM credential_requirements cr
      JOIN credential_templates ct ON cr.template_id = ct.id
      WHERE cr.unit_id = v_employee.unit_id
        AND (cr.position IS NULL OR cr.position = v_employee.position)
        AND cr.is_mandatory = true
    LOOP
      -- Check for valid credential
      IF NOT EXISTS (
        SELECT 1 FROM credentials c
        WHERE c.employee_id = p_employee_id
          AND c.template_id = req.template_id
          AND c.validity_status IN ('Valid', 'ExpiringSoon')
          AND c.issue_date <= p_shift_date
          AND c.expiry_date >= p_shift_date
      ) THEN
        -- Check for grace period eligibility
        IF req.grace_period_days > 0 AND EXISTS (
          SELECT 1 FROM credentials c
          WHERE c.employee_id = p_employee_id
            AND c.template_id = req.template_id
            AND c.validity_status = 'Expired'            -- expired, not suspended/revoked
            AND c.expiry_date < p_shift_date              -- actually expired
            AND (c.expiry_date + req.grace_period_days) >= p_shift_date  -- within grace window
            AND c.grace_cycle_id IS NOT NULL              -- grace cycle active
            AND EXISTS (                                  -- renewal in progress
              SELECT 1 FROM pending_credential_data pcd
              WHERE pcd.credential_id = c.id
                AND pcd.status = 'Pending'
            )
            AND NOT EXISTS (                              -- no prior grace for same cycle
              SELECT 1 FROM grace_period_log gpl
              WHERE gpl.credential_id = c.id
                AND gpl.status IN ('EXPIRED', 'REVOKED')
                AND gpl.grace_cycle_id = c.grace_cycle_id
            )
        ) THEN
          v_grace_applied := true;
          v_reasons := array_append(v_reasons,
            'Grace period active for ' || req.template_name ||
            ' — renewal in progress');
        ELSE
          v_eligible := false;
          v_reasons := array_append(v_reasons,
            'Missing or invalid credential: ' || req.template_name);
        END IF;
      END IF;
    END LOOP;
  END;

  IF v_eligible THEN
    IF v_grace_applied THEN
      RETURN QUERY SELECT true, 'ELIGIBLE_WITH_GRACE'::VARCHAR(30), v_reasons;
    ELSE
      RETURN QUERY SELECT true, 'ELIGIBLE'::VARCHAR(30), v_reasons;
    END IF;
  ELSE
    RETURN QUERY SELECT false, 'INELIGIBLE'::VARCHAR(30), v_reasons;
  END IF;
END;
$$ LANGUAGE plpgsql STABLE;
```

**Implementation — application service update:**

```typescript
// src/modules/eligibility/eligibility.service.ts — updated
export interface EligibilityResult {
  isEligible: boolean;
  eligibilityType: 'ELIGIBLE' | 'ELIGIBLE_WITH_GRACE' | 'INELIGIBLE';
  reasons: string[];
  graceCredentials?: GraceCredentialInfo[];  // populated when type is ELIGIBLE_WITH_GRACE
}

export interface GraceCredentialInfo {
  credentialId: number;
  templateName: string;
  expiryDate: Date;
  graceExpiryDate: Date;
  renewalStatus: string;
  daysRemainingInGrace: number;
}

@Injectable()
export class EligibilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async checkEligibility(
    employeeId: number,
    shiftDate: Date,
    actorId?: number,
  ): Promise<EligibilityResult> {
    const result = await this.prisma.$queryRaw`
      SELECT * FROM check_nurse_eligibility(${employeeId}, ${shiftDate})
    `;

    const row = (result as any[])[0];
    const eligibilityResult: EligibilityResult = {
      isEligible: row.is_eligible,
      eligibilityType: row.eligibility_type,
      reasons: row.reasons,
    };

    // If grace period is active, enrich with grace details
    if (row.eligibility_type === 'ELIGIBLE_WITH_GRACE') {
      eligibilityResult.graceCredentials =
        await this.getGraceCredentialDetails(employeeId, shiftDate);

      // Audit the grace-based eligibility determination
      await this.auditService.recordDomainEvent(this.prisma, {
        action: 'ELIGIBILITY_GRACE_APPLIED',
        resourceType: 'employee',
        resourceId: employeeId,
        actorId: actorId ?? null,
        changes: {
          shiftDate: shiftDate.toISOString(),
          graceCredentials: eligibilityResult.graceCredentials.map(gc => ({
            credentialId: gc.credentialId,
            templateName: gc.templateName,
            graceExpiryDate: gc.graceExpiryDate,
          })),
        },
      });
    }

    return eligibilityResult;
  }

  private async getGraceCredentialDetails(
    employeeId: number,
    shiftDate: Date,
  ): Promise<GraceCredentialInfo[]> {
    return this.prisma.$queryRaw`
      SELECT c.id AS credential_id,
             ct.name AS template_name,
             c.expiry_date,
             (c.expiry_date + ct.grace_period_days) AS grace_expiry_date,
             pcd.status AS renewal_status,
             ((c.expiry_date + ct.grace_period_days) - ${shiftDate}::date) AS days_remaining_in_grace
      FROM credentials c
      JOIN credential_templates ct ON c.template_id = ct.id
      LEFT JOIN pending_credential_data pcd ON pcd.credential_id = c.id AND pcd.status = 'Pending'
      WHERE c.employee_id = ${employeeId}
        AND c.validity_status = 'Expired'
        AND c.expiry_date < ${shiftDate}::date
        AND (c.expiry_date + ct.grace_period_days) >= ${shiftDate}::date
        AND c.grace_cycle_id IS NOT NULL
    `;
  }
}
```

**Implementation — grace period lifecycle management:**

```typescript
// src/modules/credentials/grace-period.service.ts
@Injectable()
export class GracePeriodService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Called by the daily scan when a credential expires and has
   * a renewal in progress. Activates the grace window.
   */
  async activateGrace(credentialId: number): Promise<void> {
    const credential = await this.prisma.credential.findUnique({
      where: { id: credentialId },
      include: { template: true },
    });

    if (!credential || !credential.template.gracePeriodDays) return;
    if (credential.graceCycleId) return; // already activated for this cycle

    const cycleId = randomUUID();
    const graceExpiryDate = addDays(
      credential.expiryDate,
      credential.template.gracePeriodDays,
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.credential.update({
        where: { id: credentialId },
        data: {
          graceActivatedAt: new Date(),
          graceExpiryDate: graceExpiryDate,
          graceCycleId: cycleId,
        },
      });

      await tx.gracePeriodLog.create({
        data: {
          credentialId,
          employeeId: credential.employeeId,
          templateId: credential.templateId,
          graceStartDate: credential.expiryDate,
          graceEndDate: graceExpiryDate,
          graceCycleId: cycleId,
          status: 'ACTIVE',
          activatedBy: 'SYSTEM',
        },
      });

      await this.auditService.recordDomainEvent(tx, {
        action: 'GRACE_PERIOD_ACTIVATED',
        resourceType: 'credential',
        resourceId: credentialId,
        actorId: null,
        changes: {
          gracePeriodDays: credential.template.gracePeriodDays,
          graceExpiryDate: graceExpiryDate.toISOString(),
          graceCycleId: cycleId,
        },
      });
    });
  }

  /**
   * Called when a renewal is approved. Closes the grace window cleanly.
   */
  async completeGrace(credentialId: number, reason: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const credential = await tx.credential.findUnique({
        where: { id: credentialId },
      });
      if (!credential?.graceCycleId) return;

      await tx.gracePeriodLog.updateMany({
        where: {
          credentialId,
          graceCycleId: credential.graceCycleId,
          status: 'ACTIVE',
        },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          completedReason: reason,
        },
      });

      await tx.credential.update({
        where: { id: credentialId },
        data: {
          graceActivatedAt: null,
          graceExpiryDate: null,
          graceCycleId: null,
        },
      });
    });
  }

  /**
   * Called by the daily scan to expire grace windows that have run out.
   * Triggers eligibility revalidation for affected future assignments.
   */
  async expireGraceWindows(): Promise<number> {
    const today = new Date();
    const expired = await this.prisma.$queryRaw`
      UPDATE grace_period_log
      SET status = 'EXPIRED',
          completed_at = now(),
          completed_reason = 'GRACE_EXPIRED'
      WHERE status = 'ACTIVE'
        AND grace_end_date < ${today}::date
      RETURNING credential_id, employee_id
    `;
    // Trigger revalidation for each affected employee
    for (const row of expired as any[]) {
      await this.triggerRevalidation(row.employee_id);
    }
    return (expired as any[]).length;
  }
}
```

**Grace period configuration guidance for HR:**

| Credential template | Recommended grace period | Rationale |
| :--- | :--- | :--- |
| SCFHS Professional License | 30 days | SCFHS renewal processing typically takes 2–4 weeks |
| BLS / ACLS / PALS | 14 days | Life support recertification courses run frequently |
| Passport / National ID | 30 days | Government ID renewal can involve external agencies |
| Hospital ID | 0 days (no grace) | Internally issued — immediate replacement possible |
| Core Competency | 7 days | Internal assessment scheduling |
| Medical Malpractice Insurance | 0 days (no grace) | Liability coverage gap is unacceptable |

These are recommendations only. HR must configure grace periods per hospital policy and regulatory requirements. A grace period of `0` (the default) preserves the current behavior — expiry immediately blocks eligibility.

**Acceptance criteria for grace periods:**

| Criterion | Required evidence |
| :--- | :--- |
| Grace activation | A credential with `grace_period_days > 0` and a pending renewal automatically enters grace on expiry; the `grace_period_log` entry is created |
| Eligibility with grace | The eligibility engine returns `ELIGIBLE_WITH_GRACE` for a nurse whose only expired credential is within its grace window with a renewal in progress |
| Grace indicator on roster | Published assignments using grace eligibility display a visual "Grace Active" indicator to supervisors and HR |
| Grace expiry | A grace window that expires without renewal completion demotes future published assignments to draft and generates an HR notification |
| Renewal approval closes grace | Approving a renewal during the grace window sets `grace_period_log.status = 'COMPLETED'` and clears the grace fields on the credential |
| Renewal rejection closes grace | Rejecting a renewal during the grace window reverts eligibility to ineligible immediately |
| No stacking | A second consecutive expiry on the same credential (without a completed renewal between cycles) does not receive a grace window |
| Audit trail | Every grace activation, completion and expiry has a `grace_period_log` entry and a domain audit event |
| Suspension/revocation overrides grace | A credential suspended or revoked during its grace window immediately loses eligibility regardless of grace configuration |

#### 6.1.1.1 Policy transitions (MANDATORY → TRANSITION)

**Specification:** The eligibility engine distinguishes between blocking and warning requirements to support phased credential policy rollouts:

- **MANDATORY state** — if `policy_status = 'MANDATORY'`, the missing credential blocks eligibility immediately.
- **TRANSITION state** — if `policy_status = 'TRANSITION'`:
  - The nurse remains ELIGIBLE, but the status is `ELIGIBLE_WITH_POLICY_WARNING`.
  - The system triggers a notification: "New requirement [Template] will become mandatory on [transition_deadline]. Please upload evidence."
  - **Hard deadline** — once `CURRENT_DATE > transition_deadline`, the system automatically treats the requirement as MANDATORY and blocks eligibility.

**Acceptance criteria for policy transitions:**

| Criterion | Required evidence |
| :--- | :--- |
| Transition mode | Set a requirement to TRANSITION mode; verify that nurses without the credential remain eligible but receive a "Policy Warning" alert |
| Hard deadline enforcement | Set `transition_deadline` to yesterday; verify that nurses are now immediately marked INELIGIBLE |

### 6.1.2 Emergency eligibility waivers

**Specification:** In critical under-staffing scenarios, a Supervisor may grant a temporary waiver to a nurse who is otherwise ineligible due to a missing credential.

**Waiver rules:**

- **Scope** — a waiver is granted for a specific nurse, for a specific credential template, for a specific time window (maximum 72 hours).
- **Authority** — only users with the Supervisor or HR_Admin role can issue a waiver.
- **Audit** — every waiver is a high-priority event. It is logged in the domain audit trail with the supervisor's ID and the clinical justification.
- **Priority** — a valid waiver overrides any ineligible status for that specific credential during the waiver's validity period. The waiver is recorded in the eligibility reasons so the materialized state reflects the override.
- **Enforcement in the database** — the 72-hour maximum and the future-expiry requirement are enforced by `chk_waiver_max_window` and `chk_waiver_future` on `credential_waivers` (V48); the API applies the same checks so callers receive a clear error before the constraint fires. Role authority remains an application-level check.

**Implementation — waiver check in eligibility engine:**

```typescript
// Added to the eligibility calculation loop
const activeWaiver = await tx.credentialWaivers.findFirst({
  where: {
    employee_id: empId,
    template_id: req.templateId,
    expiry_date: { gt: new Date() }
  }
});

if (activeWaiver) {
  // Record the waiver in reasons for audit visibility
  reasons.push(`Waiver active for ${req.templateName} until ${activeWaiver.expiry_date} — waived by ${activeWaiver.waived_by}`);
  continue; // Skip the ineligible trigger for this specific credential
}
```

**Acceptance criteria for emergency waivers:**

| Criterion | Required evidence |
| :--- | :--- |
| Waiver grants eligibility | Create a waiver for an ineligible nurse; verify that their status changes to ELIGIBLE immediately |
| Automatic expiry | Verify that the waiver expires automatically at the `expiry_date` timestamp, reverting the nurse to INELIGIBLE |
| High-priority audit | Verify that waiver creation triggers a high-priority audit entry with supervisor ID and clinical justification |
| Maximum duration | Verify that a waiver with duration exceeding 72 hours is rejected |
| Authority check | Verify that only Supervisor and HR_Admin roles can issue waivers; other roles receive 403 |

### 6.2 Assignment and publication

**Specification:**

- Draft assignment writes and publication are guarded on the server and by database validation.
- Changing credential validity, contract coverage, employee status/position or applicable requirements triggers a recheck of future published assignments. Invalid future assignments are retained as drafts for review.
- Daily scanning handles changes caused by date passage (contract expiry, credential expiry).
- Scoped supervisors draft and publish a unit/date window. Publication validates all assignments in one transaction.
- Employees see published personal and home-unit schedules only. Unpublished shifts are excluded from both roster and employee detail views.

**Schedule row fields:** employee name/number, unit, shift, date, status, notes. Notes are visible in the published unit view — they must contain only schedule-appropriate information.

### 6.3 Coverage monitoring

**Specification:**

- Coverage compares eligible, noncancelled assignments against configured unit/shift minimums.
- Draft and published counts are reported separately.
- Missing targets are shown as unspecified (not as zero).
- A shortage is a warning — it does not bypass credential checks and does not block publication.
- Date-window operations are bounded to 94 days.

---

## 7. Notifications

### 7.1 Daily scan and event creation

**Specification:** The system scans for upcoming expirations and creates persistent notification records for affected employees and HR users.

**Scan schedule:** Daily at 06:00 Asia/Riyadh (03:00 UTC).

**Scan windows:**

- Contract reminders: 90-day window before expiry.
- Credential reminders: 60-day window before expiry, plus already-expired credentials.

**Rules:**

- Window queries catch late imports or missed daily runs. Delivery is not guaranteed at exactly the 90th or 60th day if the service was unavailable, but the next successful run catches up.
- Each event creates persistent recipient-specific dashboard and email records for both the employee and scoped active HR users.
- An unregistered employee can receive email through the approved contact record. A later scan can attach that reminder to the claimed account.
- Acknowledgement belongs to the recipient; one user cannot acknowledge another user's notification.

**Event deduplication:** An event key contains the record ID, expiry date and milestone. Unique event/email keys prevent duplicate queue rows on rescanning.

### 7.2 SMTP email delivery

**Specification:** The SMTP worker runs every 60 seconds, uses a 10-minute processing lease, records delivery outcomes and retries up to 8 attempts. Email delivery is **at-least-once**: a process failure after SMTP acceptance but before a success update may repeat a message.

**Implementation — SMTP configuration:**

```env
# .env.production — SMTP section
SMTP_HOST=smtp.aigh.local              # hospital relay hostname
SMTP_PORT=587                          # STARTTLS port (never 25 unencrypted)
SMTP_SECURE=false                      # false = STARTTLS upgrade; true = implicit TLS (465)
SMTP_USER=nurseapp@aigh.sa             # dedicated service account
SMTP_PASS=${SMTP_SECRET}               # from deployment secrets — never in source
SMTP_FROM="AIGH Workforce <nurseapp@aigh.sa>"
SMTP_TLS_REJECT_UNAUTHORIZED=true      # verify hospital relay certificate

# Delivery tuning
SMTP_RETRY_MAX=8                       # matches existing retry count
SMTP_RETRY_DELAY_MS=60000              # 1 minute between retries
SMTP_LEASE_MINUTES=10                  # processing lease duration
```

**Implementation — email template requirements:**

| Requirement | Implementation |
| :--- | :--- |
| Stable Message-ID | Use the event key — same ID on retry prevents duplicate display in most clients |
| Both HTML and plain text | Always send multipart/alternative — hospital clients may strip HTML |
| UTF-8 encoding | Set `Content-Type: text/html; charset=utf-8` explicitly |
| No external images | Inline all images as base64 or use text-only — hospital firewalls block external loads |
| Reply-To header | Point to a monitored HR mailbox, not the service account |
| X-Priority header | Set to `1` (High) for expired credentials; `3` (Normal) otherwise |

**Implementation — email template example:**

```typescript
// src/modules/notifications/templates/credential-expiry.ts
export function buildCredentialExpiryEmail(data: {
  employeeName: string;
  credentialType: string;
  expiryDate: string;       // formatted in Asia/Riyadh
  daysRemaining: number;
  isExpired: boolean;
  eventKey: string;
}) {
  return {
    subject: data.isExpired
      ? `[Action Required] ${data.credentialType} has expired`
      : `${data.credentialType} expires in ${data.daysRemaining} days`,
    headers: {
      'Message-ID': `<${data.eventKey}@nurseapp.aigh.sa>`,
      'X-Priority': data.isExpired ? '1' : '3',
      'X-Mailer': 'AIGH-NurseApp/0.2.1',
    },
    html: `...inline HTML with both Arabic and English...`,
    text: `...plain-text fallback for all clients...`,
  };
}
```

### 7.3 SMTP staging verification checklist

**Implementation — verify each step before going live:**

1. **Send a test email** to a real staging mailbox using the hospital SMTP relay. Verify authentication succeeds, TLS handshake completes and the email arrives.
2. **Check email rendering** in Outlook (hospital standard), Gmail and mobile clients. Verify Arabic/English character encoding (UTF-8), From/Reply-To headers and that the Subject line does not trigger spam scoring.
3. **Test credential expiry notification** end-to-end: set a test credential to expire within 60 days, run the daily scan manually, confirm the notification record is created, confirm the SMTP worker picks it up and delivers within 60 seconds.
4. **Test contract expiry notification** similarly for the 90-day window.
5. **Simulate SMTP failure**: stop the relay, run the worker, confirm it logs the failure, marks the attempt and retries up to 8 times. Restart the relay and confirm recovery delivery succeeds.
6. **Verify deduplication**: run the daily scan twice for the same date. Confirm no duplicate notification records are created (unique event key enforcement).
7. **Verify at-least-once behavior**: kill the worker process after SMTP acceptance but before the success database update. Restart and confirm the email is re-sent (documented and expected behavior).

### 7.4 Delivery health monitoring

**Implementation — health endpoint:**

```typescript
// src/modules/notifications/notification-health.service.ts
@Injectable()
export class NotificationHealthService {
  async getHealth(): Promise<NotificationHealth> {
    return {
      oldestPendingEmail:    await this.getOldestPending(),
      failedAttemptsLast24h: await this.getFailedCount(24),
      exhaustedRetries:      await this.getExhaustedCount(),
      lastSuccessfulSend:    await this.getLastSuccess(),
      workerLastHeartbeat:   await this.getWorkerHeartbeat(),
    };
  }
}

// Alert conditions:
// - oldestPendingEmail > 30 minutes   → worker may be stuck
// - exhaustedRetries > 0              → emails permanently failed — investigate
// - workerLastHeartbeat > 5 minutes   → worker process may be down
```

### 7.5 Failure handling

**Specification:** The system handles infrastructure failures gracefully without losing data.

| Failure | Expected behavior |
| :--- | :--- |
| Redis unavailable | Use database authorization; slower responses are acceptable |
| SMTP unavailable | Save notification intent; retry mail; alert on exhausted attempts |
| Document storage unavailable | Hold evidence as pending; retain current approved credential |
| Audit persistence fails | Roll back the associated domain mutation |
| Database unavailable | Return a controlled unavailable response; never enter mock mode |
| Worker misses a scheduled run | Catch up from persisted dates/events without duplicate queue rows |
| Push gateway unavailable | Fall back to SMTP-only delivery; push status marked as failed with retry |

### 7.6 Mobile push notifications

**Specification:** The system delivers real-time push notifications to nurses' mobile devices through a hospital-approved push gateway (Firebase Cloud Messaging or a hospital-managed alternative). Push notifications supplement — but do not replace — SMTP email and dashboard alerts. A notification is considered delivered when any one channel succeeds.

**Notification channels and priority:**

| Channel | Delivery | Persistence | Suitable for |
| :--- | :--- | :--- | :--- |
| Dashboard (existing) | On next login/refresh | Persisted until acknowledged | All notification types |
| Email / SMTP (existing) | At-least-once via worker | Persisted in email queue | Formal reminders, audit trail |
| Push notification (new) | Real-time to registered devices | Transient — delivery attempt only | Urgent alerts, schedule changes, grace warnings |

**Push notification triggers:**

| Event | Push message | Priority | Recipients |
| :--- | :--- | :--- | :--- |
| Credential expires in 14 days | "Your {credential} expires on {date} — renewal required" | Normal | Employee |
| Credential expired (grace active) | "Your {credential} has expired — grace period active until {grace_end}" | High | Employee |
| Grace period expires in 3 days | "Grace period for {credential} ends on {date} — submit renewal now" | High | Employee + scoped HR |
| SCFHS adverse status detected | "{employee} — SCFHS reports {status} for {credential}" | High | Scoped HR |
| Schedule published | "Your schedule for {date_range} has been published" | Normal | Affected employees |
| Assignment demoted (eligibility lost) | "Assignment on {date} moved to draft — {reason}" | High | Employee + supervisor |
| Credential renewal approved | "Your {credential} renewal has been approved" | Normal | Employee |
| Credential renewal rejected | "Your {credential} renewal was not approved — action required" | High | Employee |

**Architecture:**

```mermaid
flowchart LR
    subgraph NurseApp Backend
        NS[Notification Service] --> PD[Push Delivery Service]
        NW[Notification Worker] --> PD
    end
    PD -->|Device token + payload| PG[Push Gateway Adapter]
    PG -->|FCM HTTP v1 API| FCM[Firebase Cloud Messaging]
    PG -->|Alternative| HPG[Hospital Push Gateway]
    FCM --> MD1[iOS Device]
    FCM --> MD2[Android Device]
    HPG --> MD3[Hospital MDM Devices]
    subgraph NurseApp Frontend
        MA[Mobile/Web App] -->|Register device token| DR[Device Registration API]
    end
    DR --> DT[(device_push_tokens)]
```

**Implementation — database schema:**

```sql
-- prisma/migrations/V34_push_notifications.sql

-- Device push token registration
CREATE TABLE device_push_tokens (
  id              BIGSERIAL PRIMARY KEY,
  account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  device_token    VARCHAR(500) NOT NULL,              -- FCM/APNS registration token
  device_platform VARCHAR(20) NOT NULL,               -- 'ios', 'android', 'web'
  device_name     VARCHAR(200),                       -- user-friendly device label
  push_gateway    VARCHAR(30) NOT NULL DEFAULT 'fcm', -- 'fcm', 'hospital_gateway'
  is_active       BOOLEAN NOT NULL DEFAULT true,
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,                        -- token expiry (FCM tokens can expire)

  CONSTRAINT uq_device_token UNIQUE (device_token)
);

CREATE INDEX idx_dpt_account ON device_push_tokens(account_id) WHERE is_active = true;

-- Push delivery log
CREATE TABLE push_delivery_log (
  id                BIGSERIAL PRIMARY KEY,
  notification_id   INTEGER NOT NULL,                 -- references the notification event
  account_id        INTEGER NOT NULL,
  device_token_id   BIGINT NOT NULL REFERENCES device_push_tokens(id),
  push_gateway      VARCHAR(30) NOT NULL,
  payload_hash      VARCHAR(64) NOT NULL,             -- SHA-256 of push payload
  status            VARCHAR(30) NOT NULL DEFAULT 'PENDING',  -- 'PENDING', 'SENT', 'DELIVERED', 'FAILED', 'EXPIRED_TOKEN'
  gateway_message_id VARCHAR(200),                    -- FCM message ID for tracking
  error_message     VARCHAR(500),
  attempt_count     SMALLINT NOT NULL DEFAULT 0,
  sent_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_pdl_notification ON push_delivery_log(notification_id);
CREATE INDEX idx_pdl_status       ON push_delivery_log(status) WHERE status IN ('PENDING', 'FAILED');
```

**Implementation — push delivery service:**

```typescript
// src/modules/notifications/push/push-delivery.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { PushGatewayAdapter } from './push-gateway.adapter';
import { AuditService } from '../../audit/audit.service';
import { createHash } from 'crypto';

export interface PushPayload {
  title: string;
  body: string;
  priority: 'normal' | 'high';
  data?: Record<string, string>;   // custom key-value pairs for the app
  badge?: number;                  // iOS badge count
  channelId?: string;              // Android notification channel
}

@Injectable()
export class PushDeliveryService {
  private readonly logger = new Logger(PushDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PushGatewayAdapter,
    private readonly auditService: AuditService,
  ) {}

  /**
   * Send a push notification to all active devices for an account.
   * Returns the number of successful deliveries.
   */
  async sendToAccount(
    accountId: number,
    notificationId: number,
    payload: PushPayload,
  ): Promise<number> {
    // Get all active device tokens for this account
    const tokens = await this.prisma.devicePushToken.findMany({
      where: {
        accountId,
        isActive: true,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date() } },
        ],
      },
    });

    if (tokens.length === 0) {
      this.logger.debug(`No active push tokens for account ${accountId}`);
      return 0;
    }

    const payloadHash = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');

    let successCount = 0;

    for (const token of tokens) {
      // Create delivery log entry
      const logEntry = await this.prisma.pushDeliveryLog.create({
        data: {
          notificationId,
          accountId,
          deviceTokenId: token.id,
          pushGateway: token.pushGateway,
          payloadHash,
          status: 'PENDING',
        },
      });

      try {
        const result = await this.gateway.send(
          token.pushGateway,
          token.deviceToken,
          payload,
        );

        await this.prisma.pushDeliveryLog.update({
          where: { id: logEntry.id },
          data: {
            status: 'SENT',
            gatewayMessageId: result.messageId,
            sentAt: new Date(),
            attemptCount: 1,
          },
        });

        // Update last-used timestamp
        await this.prisma.devicePushToken.update({
          where: { id: token.id },
          data: { lastUsedAt: new Date() },
        });

        successCount++;
      } catch (error) {
        // Handle expired/invalid tokens
        if (this.isTokenExpiredError(error)) {
          await this.prisma.devicePushToken.update({
            where: { id: token.id },
            data: { isActive: false },
          });
          await this.prisma.pushDeliveryLog.update({
            where: { id: logEntry.id },
            data: { status: 'EXPIRED_TOKEN', errorMessage: error.message },
          });
          this.logger.warn(
            `Deactivated expired push token ${token.id} for account ${accountId}`
          );
        } else {
          await this.prisma.pushDeliveryLog.update({
            where: { id: logEntry.id },
            data: {
              status: 'FAILED',
              errorMessage: error.message?.substring(0, 500),
              attemptCount: 1,
            },
          });
        }
      }
    }

    return successCount;
  }

  private isTokenExpiredError(error: any): boolean {
    // FCM returns specific error codes for invalid/expired tokens
    const expiredCodes = [
      'messaging/registration-token-not-registered',
      'messaging/invalid-registration-token',
      'NotRegistered',
      'InvalidRegistration',
    ];
    return expiredCodes.some(code =>
      error.code === code || error.message?.includes(code)
    );
  }
}
```

**Implementation — push gateway adapter (abstraction layer):**

```typescript
// src/modules/notifications/push/push-gateway.adapter.ts
import { Injectable, Logger } from '@nestjs/common';

interface PushResult {
  messageId: string;
  success: boolean;
}

@Injectable()
export class PushGatewayAdapter {
  private readonly logger = new Logger(PushGatewayAdapter.name);

  /**
   * Send a push notification through the configured gateway.
   * The adapter pattern allows swapping FCM for a hospital-managed
   * gateway without changing the delivery service.
   */
  async send(
    gateway: string,
    deviceToken: string,
    payload: PushPayload,
  ): Promise<PushResult> {
    switch (gateway) {
      case 'fcm':
        return this.sendViaFcm(deviceToken, payload);
      case 'hospital_gateway':
        return this.sendViaHospitalGateway(deviceToken, payload);
      default:
        throw new Error(`Unknown push gateway: ${gateway}`);
    }
  }

  private async sendViaFcm(
    deviceToken: string,
    payload: PushPayload,
  ): Promise<PushResult> {
    // Firebase Admin SDK — HTTP v1 API
    const { getMessaging } = await import('firebase-admin/messaging');

    const message = {
      token: deviceToken,
      notification: {
        title: payload.title,
        body: payload.body,
      },
      data: payload.data,
      android: {
        priority: payload.priority === 'high' ? 'high' as const : 'normal' as const,
        notification: {
          channelId: payload.channelId ?? 'nurseapp_default',
          icon: 'ic_notification',
        },
      },
      apns: {
        payload: {
          aps: {
            alert: { title: payload.title, body: payload.body },
            badge: payload.badge,
            sound: payload.priority === 'high' ? 'critical.aiff' : 'default',
          },
        },
        headers: {
          'apns-priority': payload.priority === 'high' ? '10' : '5',
        },
      },
    };

    const messageId = await getMessaging().send(message);
    return { messageId, success: true };
  }

  private async sendViaHospitalGateway(
    deviceToken: string,
    payload: PushPayload,
  ): Promise<PushResult> {
    // Hospital-managed push gateway — configure URL and auth via env
    const response = await fetch(process.env.HOSPITAL_PUSH_GATEWAY_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.HOSPITAL_PUSH_GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        deviceToken,
        title: payload.title,
        body: payload.body,
        priority: payload.priority,
        data: payload.data,
      }),
    });

    if (!response.ok) {
      throw new Error(`Hospital push gateway error: ${response.status}`);
    }

    const result = await response.json();
    return { messageId: result.id, success: true };
  }
}
```

**Implementation — device registration API:**

```typescript
// src/modules/notifications/push/push-registration.controller.ts
@Controller('api/v1/push')
@UseGuards(JwtAuthGuard, CsrfGuard)
export class PushRegistrationController {
  constructor(private readonly pushService: PushRegistrationService) {}

  @Post('register')
  async registerDevice(
    @Body() dto: RegisterDeviceDto,
    @Req() req: Request,
  ) {
    return this.pushService.registerDevice(
      req.user.id,
      dto.deviceToken,
      dto.platform,      // 'ios' | 'android' | 'web'
      dto.deviceName,
      dto.pushGateway,   // 'fcm' | 'hospital_gateway'
    );
  }

  @Delete('unregister')
  async unregisterDevice(
    @Body() dto: UnregisterDeviceDto,
    @Req() req: Request,
  ) {
    return this.pushService.unregisterDevice(req.user.id, dto.deviceToken);
  }

  @Get('devices')
  async getMyDevices(@Req() req: Request) {
    return this.pushService.getActiveDevices(req.user.id);
  }
}
```

**Implementation — environment configuration:**

```env
# .env.production — Push notifications section

# Option A: Firebase Cloud Messaging
PUSH_GATEWAY=fcm
FIREBASE_SERVICE_ACCOUNT_PATH=/etc/nurseapp/firebase-sa.json   # service account key
FCM_PROJECT_ID=aigh-nurseapp                                    # Firebase project

# Option B: Hospital-managed push gateway (alternative to FCM)
# PUSH_GATEWAY=hospital_gateway
# HOSPITAL_PUSH_GATEWAY_URL=https://push.aigh.local/api/v1/send
# HOSPITAL_PUSH_GATEWAY_TOKEN=${HOSPITAL_PUSH_SECRET}

# Push notification behavior
PUSH_ENABLED=true                    # master switch — disable to suppress all push
PUSH_RETRY_MAX=3                     # max attempts per device per notification
PUSH_TOKEN_CLEANUP_DAYS=90           # deactivate tokens unused for 90 days
```

**Push notification rules:**

- Push notifications are **opt-in per device** — an employee must register their device through the app. No device token is collected without explicit action.
- Push content is **minimal** — titles and body text contain enough context to understand the alert but never include patient data, private identity numbers or document contents. The `data` payload carries IDs that the app resolves locally.
- Push delivery is **best-effort** — a failed push does not block or retry the business operation. SMTP email and dashboard notifications remain the reliable channels.
- Expired or invalid device tokens are **automatically deactivated** on delivery failure. Tokens unused for 90 days are cleaned up by the daily worker.
- The push gateway adapter allows **swapping FCM for a hospital-managed alternative** without changing the delivery service or notification logic.
- Push notifications respect the **notification deduplication** already in place (Section 7.1) — the same event key does not trigger duplicate pushes.
- An employee who logs out or has their session revoked should **unregister their device token** from the client side to stop receiving pushes.

**Acceptance criteria for mobile push notifications:**

| Criterion | Required evidence |
| :--- | :--- |
| Device registration | Employee registers a device; token is stored and active; device appears in "My Devices" list |
| Push delivery | A credential expiry notification generates a push to all registered devices; push arrives within 10 seconds |
| High-priority delivery | Grace period and SCFHS adverse status pushes arrive even when the device is in doze/battery-saving mode |
| Expired token handling | A push to an invalid token deactivates it; no repeated delivery attempts to dead tokens |
| Multi-device | An employee with 2 registered devices receives the push on both |
| Gateway abstraction | Switching `PUSH_GATEWAY` from `fcm` to `hospital_gateway` delivers pushes through the hospital endpoint |
| Fallback | Push gateway unavailability does not affect SMTP or dashboard notifications |
| Deduplication | Running the daily scan twice does not send duplicate pushes for the same event |
| Unregistration | Logging out removes the device token; no further pushes arrive |
| Content safety | Push payloads contain no private identity numbers, document contents or patient data |

---

## 8. Role and data-scope policy

### 8.1 Role-based access matrix

**Specification:** Every operation evaluates role permission, record scope and permitted response fields. Default access is denied.

| Area | HR Admin / System Admin | Supervisor / Scheduler | Employee |
| :--- | :--- | :--- | :--- |
| Accounts | Provision and administer within assigned scope | No account administration by default | Claim invited account; own password |
| Employee Master | Maintain source fields within scope | Assigned-unit baseline/compliance view; private fields suppressed | Own profile; phone update |
| Contracts | Scoped create, approval, renewal, termination | Scoped reduced read view | Own reduced read view |
| Credentials | Scoped upload, review, validity decisions | Scoped compliance view; no evidence downloads | Own submission, evidence, alerts |
| Scheduling | Coverage/read view by default | Scoped draft and publish | Published personal/home-unit view |
| Notifications | Own recipient rows | Own recipient rows | Own recipient rows |

**Administrative guardrails (four-eyes & PAM):** To prevent "God-Mode" risks and insider threats, the system implements two critical governance controls:

- **The Four-Eyes Principle (dual-authorization)** — high-impact actions (defined in the registry) cannot be executed by a single administrator. High-impact actions include promoting a user to System Admin, modifying global eligibility rules, or changing security encryption keys. Workflow: Admin A initiates the request → request enters `PENDING` state → Admin B (a different user) reviews and approves → the system executes the change.
- **Just-In-Time (JIT) elevation (PAM)** — privileged access is not permanent. System Admin rights are "dormant" by default. To perform administrative tasks, the user must request elevation. Elevation is granted for a limited window (e.g., 2 hours) and requires a documented reason. Once `expires_at` is reached, the session is automatically revoked by the `PamExpiryWorker`.

### 8.2 Access rules

- Employee title never automatically confers an administrative role. HR must explicitly assign elevated roles and scopes.
- Executive positions (DON, DEPUTY_DON) and administrative positions (ADMIN) do not automatically confer system privileges. Each holder receives the staff self-service authorization role at registration and requires explicit HR assignment of an elevated role (HR Admin, System Admin, Supervisor) to access administrative functions.
- Nursing Supervisor (NS) and Acting Head Nurse (ACTING_HEAD) positions do not automatically grant Supervisor authorization role. HR must explicitly assign the Supervisor role with appropriate unit scope.
- NURSE_EDUCATOR may require cross-unit read access for training purposes. This is granted through explicit scope configuration, not through the position code.
- Apply the same permission checks to exports, document versions, reports and background actions initiated by a user.
- The database migration narrows legacy clinical-only account scopes to personal access and removes default supervisor contract writes and account-administration rights.
- Explicit locally customized grants still require review.

**Recommended authorization role mapping for new positions:**

| Position | Default Auth Role | Typical Elevated Role | Notes |
| :--- | :--- | :--- | :--- |
| DON | Staff self-service | HR Admin (system-wide scope) | Requires explicit HR assignment |
| DEPUTY_DON | Staff self-service | HR Admin (scoped) | Requires explicit HR assignment |
| ADMIN | Staff self-service | HR Admin or Scheduler | Non-clinical; scope per hospital policy |
| NS | Staff self-service | Supervisor (multi-unit scope) | May need broader unit scope than HN |
| ACTING_HEAD | Staff self-service | Supervisor (unit-scoped, temporary) | Review grant on assignment end |
| NURSE_EDUCATOR | Staff self-service | Read-only credential view (scoped) | May need cross-unit read access for training |
| PRACTITIONER | Staff self-service | None additional | Advanced clinical, not administrative |

### 8.3 Data protection and Saudi PDPL compliance

**Specification:** The system processes sensitive personal data (Iqama, passport, SCFHS registration) and must comply with the Saudi Personal Data Protection Law (PDPL) and SDAIA regulations.

#### 8.3.1 Data classification

| Class | Fields |
| :--- | :--- |
| Ordinary personal data | Name, Job Number, Department, Email |
| Sensitive personal data | Iqama Number, Passport Number, SCFHS Registration Number, Identity/Licensure scans |

#### 8.3.2 Lawful basis and purpose limitation

Processing is based on the employment contract and regulatory healthcare requirements. Sensitive data processing is gated by a `ProcessingRegisterService` that records the specific lawful basis for each category of sensitive data collected.

#### 8.3.3 Data-subject rights

The system supports the following rights via a `data_subject_requests` table:

- **Access / Portability** — `DataSubjectExportService` generates a secure package of all personal data associated with an account.
- **Rectification** — standard CRUD on the employee master.
- **Erasure (Right to be Forgotten) via crypto-shredding** — to comply with PDPL without breaking the immutable hash-chain of the audit logs, the system uses crypto-shredding. When a request for erasure is approved, the system deletes the user's unique entry from the `user_encryption_keys` table. The audit logs remain structurally intact (the hash chain is not broken), but all PII encrypted with that user's key becomes mathematically unreadable. This is legally accepted as irreversible destruction of data.
- **Scope of erasure (backups)** — crypto-shredding removes readability in the **live** database. Encrypted backups and WAL archives taken before key destruction still contain the ciphertext; the 30-day backup retention (Section 10.6) bounds how long that ciphertext exists. The destroyed key is never restored, and the erasure record captures both the key-destruction time and the date the affected backups expire — this is the evidence provided for a PDPL erasure request.

#### 8.3.4 Technical security measures

- **Field-level encryption** — sensitive identifiers (Iqama, Passport) are encrypted at rest using AES-256-GCM via a `FieldCryptoService`. This is non-deterministic and provides maximum security but prevents direct database searching.
- **Blind indexing for searchability** — to allow O(1) search performance without decrypting the entire database, the system implements blind indexes. For every encrypted sensitive field (e.g. `iqama_number`), a corresponding blind-index column is created (e.g. `iqama_blind_index`). The index stores a deterministic HMAC-SHA256 hash of the plaintext value, keyed with a secret `PDPL_BLIND_INDEX_PEPPER` that lives in the deployment secret store, never in the database. Search flow: the API hashes the user's search query using the pepper → queries the `_blind_index` column → retrieves the record → decrypts the ciphertext for display. Digests record their key version in `*_blind_key_version` (V37), so the pepper can be rotated by writing new digests on update and re-indexing lazily — no single global re-index, no downtime.
- **Log redaction** — a global `LogRedactionInterceptor` masks patterns matching Iqama and Passport numbers in all application logs and error traces.
- **Privilege separation** — only the `nurseapp_runtime` role has access to encryption keys; the `nurseapp_audit_reader` sees only redacted versions.

#### 8.3.5 Retention and destruction

- **Retention** — data is kept for the duration of employment plus the legally required period (e.g. 10 years for clinical records).
- **Destruction** — soft-deleted records are permanently purged after the retention window.

#### 8.3.6 Data residency (KSA)

- **Requirement** — all production data, backups and WAL archives must reside within the Kingdom of Saudi Arabia.
- **Technical control** — the application performs a Residency Startup Check against the `DATA_RESIDENCY_REGION` environment variable. If the region is not in the `PDPL_ALLOWED_REGIONS` list, the application fails to boot. Scope of this control: it detects a **misconfigured deployment**; it does not attest the physical location of data. Residency is evidenced by hosting contracts and infrastructure attestation, not by an environment variable.

**Implementation — V35 PDPL controls (encryption columns, processing register, data-subject rights):**

```sql
-- prisma/migrations/V35_pdpl_controls.sql
-- Field-level encryption columns, processing register and data-subject rights.
-- Encryption is AES-256-GCM via FieldCryptoService (non-deterministic, so the
-- ciphertext column cannot be searched — blind indexes are added by V37).

ALTER TABLE employees
  ADD COLUMN iqama_ciphertext    BYTEA,
  ADD COLUMN passport_ciphertext BYTEA;

ALTER TABLE credentials
  ADD COLUMN scfhs_reg_ciphertext BYTEA;

-- Processing register: the documented lawful basis per sensitive category
-- (PDPL Art. 4 / SDAIA guidance). The application refuses to store a sensitive
-- field that has no active register row.
CREATE TABLE processing_register (
  id             SERIAL PRIMARY KEY,
  data_category  VARCHAR(50) NOT NULL,   -- 'IQAMA', 'PASSPORT', 'SCFHS_REG', 'IDENTITY_SCAN'
  lawful_basis   VARCHAR(50) NOT NULL,   -- 'EMPLOYMENT_CONTRACT', 'LEGAL_OBLIGATION'
  purpose        TEXT NOT NULL,
  retention_rule TEXT NOT NULL,
  is_active      BOOLEAN NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_processing_register UNIQUE (data_category, lawful_basis)
);

-- Data-subject rights (PDPL Art. 12–14): access, portability, rectification, erasure.
CREATE TABLE data_subject_requests (
  id            BIGSERIAL PRIMARY KEY,
  employee_id   INTEGER REFERENCES employees(id),
  request_type  VARCHAR(20) NOT NULL
    CHECK (request_type IN ('ACCESS', 'PORTABILITY', 'RECTIFICATION', 'ERASURE')),
  status        VARCHAR(20) NOT NULL DEFAULT 'RECEIVED'
    CHECK (status IN ('RECEIVED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'COMPLETED')),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ,
  decided_by    INTEGER REFERENCES accounts(id),
  decision_note TEXT,
  CONSTRAINT chk_decision_consistency
    CHECK ((status IN ('APPROVED', 'REJECTED', 'COMPLETED')) = (decided_at IS NOT NULL))
);

CREATE INDEX idx_dsr_status   ON data_subject_requests(status, requested_at DESC);
CREATE INDEX idx_dsr_employee ON data_subject_requests(employee_id, requested_at DESC);
```

The master encryption key is never stored in the database: it lives in the
hospital's key facility (HSM, KMS or file-based vault) and is referenced by
`PDPL_FIELD_ENCRYPTION_KEY` (below). Key storage strategy is decided with the
hosting decision (Section 13.4.1).

**Implementation — environment configuration:**

```env
# .env.production — PII & search security
PDPL_FIELD_ENCRYPTION_KEY=...       # AES-256-GCM key for ciphertext
PDPL_BLIND_INDEX_PEPPER=...         # Secret key for HMAC-SHA256 indexing
# KSA-only allowlist. Use the chosen provider's KSA region IDs, for example:
#   Oracle (Jeddah / Riyadh):  me-jeddah-1, me-riyadh-1
#   Google (Dammam):           me-central-2
#   On-premise pilot:          ksa-onprem
# NEVER include non-KSA regions: AWS me-south-1 is Bahrain, me-central-1 is the UAE.
PDPL_ALLOWED_REGIONS=me-jeddah-1,me-riyadh-1,ksa-onprem  # Region validation for startup check
```

**Allowlist integrity (2.8.7a correction):** earlier revisions showed `me-south-1` in the example allowlist — that region is AWS **Bahrain**, which contradicts the KSA residency requirement stated immediately above. The startup check must fail closed when the allowlist is empty or contains any region outside the hospital's approved KSA list; the list is maintained per provider and re-reviewed at each hosting decision (Section 13.4.1).

**Implementation — blind index search logic:**

```typescript
// src/modules/identity/crypto/blind-index.service.ts
@Injectable()
export class BlindIndexService {
  private readonly pepper = process.env.PDPL_BLIND_INDEX_PEPPER;

  generateIndex(value: string): string {
    return createHmac('sha256', this.pepper)
      .update(value)
      .digest('hex');
  }
}

// src/modules/workforce/workforce.service.ts
async findEmployeeByIqama(iqama: string) {
  const blindIndex = this.blindIndexService.generateIndex(iqama);

  // Query the hash, not the plaintext or the ciphertext
  return this.prisma.employee.findUnique({
    where: { iqama_blind_index: blindIndex }
  });
}
```

**Implementation — crypto-shredding logic:**

```typescript
// src/modules/identity/crypto/shredding.service.ts
@Injectable()
export class ShreddingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Irreversibly destroys access to a user's PII in audit logs
   * without breaking the hash-chain integrity.
   */
  async shredUserPII(employeeId: number, actorId: number) {
    return this.prisma.$transaction(async (tx) => {
      // 1. Delete the user's specific encryption key
      // Once this row is gone, the ciphertext in audit_entries cannot be decrypted
      await tx.userEncryptionKey.delete({
        where: { user_id: employeeId }
      });

      // 2. Log the erasure event (this event itself contains no PII)
      await tx.auditEntry.create({
        data: {
          actor_id: actorId,
          action: 'PII_CRYPTO_SHREDDED',
          resource: 'user_encryption_keys',
          resource_id: employeeId,
          timestamp: new Date(),
        }
      });
    });
  }
}
```

---

## 9. Audit and persistence

### 9.1 Domain-level audit (transactional)

**Specification:** Database triggers write sanitized audit events in the same transaction as employee, credential, document-version, contract and roster changes. An audit failure rolls back the affected mutation.

**Rules:**

- The hash-chain insertion path is serialized to avoid concurrent chain forks.
- Sanitized domain events record affected field names and status transitions rather than copies of private values.
- Passwords, tokens and document bodies are excluded from event payloads.
- PII encryption in logs: any audit event containing sensitive personal data must be encrypted using the specific user's key from the `user_encryption_keys` table.
- Audit integrity: the hash of the audit entry is calculated after encryption. This ensures that deleting the encryption key (crypto-shredding) does not change the record's hash, thereby preserving the chain's integrity.
- Scheduled events may have no interactive actor.
- Partitioning, hash chaining and access controls support audit integrity but do not establish regulatory certification. Hospital retention, privileged database administration and backup controls remain operational responsibilities.

**Implementation — canonical audit schema (baseline, `audit_entries`):**

```sql
-- Baseline schema (applied by the existing V01–V26 chain). Reproduced here
-- because this table is referenced by every module, by the privilege grants in
-- Section 10.7 and by the restore procedure in Section 10.6.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE audit_entries (
  id            BIGSERIAL PRIMARY KEY,
  actor_id      INTEGER,                    -- NULL for scheduled/system events
  action        VARCHAR(100) NOT NULL,
  resource      VARCHAR(100) NOT NULL,
  resource_id   VARCHAR(100),
  changes       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- sanitized names/transitions only
  previous_hash VARCHAR(64),
  hash          VARCHAR(64) NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_resource ON audit_entries(resource, resource_id, created_at DESC);
CREATE INDEX idx_audit_actor    ON audit_entries(actor_id, created_at DESC);

-- Single supported write path. Serialized with a transaction-scoped advisory
-- lock so concurrent writers cannot fork the chain (Section 9.1).
CREATE OR REPLACE FUNCTION fn_append_audit_entry(
  p_actor_id    INTEGER,
  p_action      VARCHAR,
  p_resource    VARCHAR,
  p_resource_id VARCHAR,
  p_changes     JSONB
) RETURNS BIGINT AS $$
DECLARE
  v_previous_hash VARCHAR(64);
  v_hash          VARCHAR(64);
  v_id            BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('audit_entries_chain'));

  SELECT hash INTO v_previous_hash
  FROM audit_entries
  ORDER BY id DESC
  LIMIT 1;

  v_hash := encode(
    digest(
      coalesce(v_previous_hash, '') || p_action || p_resource ||
      coalesce(p_resource_id, '') || coalesce(p_changes::text, '') ||
      extract(epoch FROM clock_timestamp())::text,
      'sha256'
    ),
    'hex'
  );

  INSERT INTO audit_entries
    (actor_id, action, resource, resource_id, changes, previous_hash, hash)
  VALUES
    (p_actor_id, p_action, p_resource, p_resource_id,
     coalesce(p_changes, '{}'::jsonb), v_previous_hash, v_hash)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

-- The is_encrypted and encryption_key_id columns are added by V38 (crypto-shredding).
```

**Rules:**

1. `fn_append_audit_entry` is the only supported write path; application code never inserts into `audit_entries` directly.
2. The hash is computed over the payload **after** any PII encryption, so destroying a user key (V38) does not invalidate the chain.
3. `nurseapp_runtime` holds `EXECUTE` on the function plus `SELECT`/`INSERT` on the table, but no `UPDATE` or `DELETE` (Section 10.7).

**Core audited records:** registration invitations, employee contacts, credential requirements, coverage requirements, credential document versions, notifications, registration rate limits, pending data/renewal progress, publication metadata, refresh-token hashes.

### 9.2 Request-level audit (forensic)

**Specification:** A global NestJS interceptor captures every HTTP request with actor, endpoint, timing and status. This is the forensic supplement to the domain audit — it answers "who called which endpoint, when, from where and what happened."

Request audit logging is fire-and-forget: it never blocks or rolls back a successful business operation. The domain-level audit (Section 9.1) remains the integrity guarantee.

**Implementation — database schema:**

```sql
-- prisma/migrations/V46_request_audit_log.sql
CREATE TABLE request_audit_log (
  id            BIGSERIAL PRIMARY KEY,
  request_id    UUID NOT NULL DEFAULT gen_random_uuid(),
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id      INTEGER,                          -- NULL for unauthenticated
  actor_role    VARCHAR(50),
  method        VARCHAR(10) NOT NULL,             -- GET, POST, PUT, DELETE
  path          VARCHAR(500) NOT NULL,
  status_code   SMALLINT NOT NULL,
  duration_ms   INTEGER NOT NULL,
  ip_address    INET,
  user_agent    VARCHAR(500),
  params_hash   VARCHAR(64),                      -- SHA-256 of sanitized params
  error_code    VARCHAR(100),                     -- app-level error if any
  session_id    VARCHAR(100)
);

CREATE INDEX idx_ral_actor_ts ON request_audit_log(actor_id, timestamp);
CREATE INDEX idx_ral_path_ts ON request_audit_log(path, timestamp);
CREATE INDEX idx_ral_request_id ON request_audit_log(request_id);
```

**Implementation — global interceptor:**

```typescript
// src/modules/audit/audit.interceptor.ts
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { v4 as uuidv4 } from 'uuid';
import { AuditService } from './audit.service';
import { createHash } from 'crypto';

// Fields to NEVER log — even as hashes
const REDACTED_FIELDS = new Set([
  'password', 'currentPassword', 'newPassword',
  'token', 'refreshToken', 'invitationToken',
  'authorization', 'cookie',
]);

@Injectable()
export class RequestAuditInterceptor implements NestInterceptor {
  constructor(private readonly auditService: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const requestId = uuidv4();
    const startTime = Date.now();

    // Attach request ID to response headers for tracing
    const res = context.switchToHttp().getResponse();
    res.setHeader('X-Request-Id', requestId);

    const baseEntry = {
      requestId,
      actorId:   req.user?.id ?? null,
      actorRole: req.user?.role ?? null,
      method:    req.method,
      path:      req.originalUrl,
      ipAddress: req.ip,
      userAgent: req.headers['user-agent']?.substring(0, 500),
      sessionId: req.user?.sessionId ?? null,
      paramsHash: this.hashParams(req.body),
    };

    return next.handle().pipe(
      tap(() => {
        this.auditService.logRequest({
          ...baseEntry,
          statusCode: res.statusCode,
          durationMs: Date.now() - startTime,
        }).catch(() => {}); // fire-and-forget; never block the response
      }),
      catchError((err) => {
        this.auditService.logRequest({
          ...baseEntry,
          statusCode: err.status ?? 500,
          durationMs: Date.now() - startTime,
          errorCode:  err.code ?? err.constructor.name,
        }).catch(() => {});
        throw err;
      }),
    );
  }

  private hashParams(body: any): string | null {
    if (!body || Object.keys(body).length === 0) return null;
    const sanitized = { ...body };
    for (const key of Object.keys(sanitized)) {
      if (REDACTED_FIELDS.has(key.toLowerCase())) delete sanitized[key];
    }
    return createHash('sha256')
      .update(JSON.stringify(sanitized))
      .digest('hex');
  }
}
```

Register globally:

```typescript
// src/app.module.ts
import { APP_INTERCEPTOR } from '@nestjs/core';
import { RequestAuditInterceptor } from './modules/audit/audit.interceptor';

providers: [
  { provide: APP_INTERCEPTOR, useClass: RequestAuditInterceptor },
],
```

**Design rationale:**

- **Hash, don't store payloads.** The `params_hash` column stores a SHA-256 of sanitized parameters. This detects identical payloads without storing sensitive workforce fields.
- **X-Request-Id header.** Every response carries a request ID traceable through request logs, application logs and domain audit events.

### 9.3 Data ownership and caching

**Specification:**

- PostgreSQL is the system of record. Redis accelerates cached menus and permissions; losing it must not lose authoritative records or grant access.
- Permission revocation must invalidate affected caches. Sensitive operations must use fresh authorization.
- Use foreign keys, unique Job Numbers/account links and date constraints.
- Retain the exclusion constraint for overlapping Approved/Active contract periods.

### 9.3.1 Redis circuit breaker and database fallback

**Specification:** The system implements a circuit breaker pattern for Redis connectivity. When Redis is unavailable, all permission and menu queries fall back to PostgreSQL automatically. The system degrades gracefully — response times increase but no request is denied or granted incorrectly due to cache unavailability.

**Circuit breaker states:**

| State | Behavior | Transition trigger |
| :--- | :--- | :--- |
| CLOSED (normal) | All reads go to Redis; cache misses fall through to PostgreSQL and populate the cache | 5 consecutive Redis failures within 30 seconds → OPEN |
| OPEN (Redis down) | All reads bypass Redis and query PostgreSQL directly; no cache writes attempted | 60-second cooldown timer expires → HALF_OPEN |
| HALF_OPEN (probing) | A single probe request is sent to Redis; other requests continue against PostgreSQL | Probe succeeds → CLOSED (cache rebuild triggers); probe fails → OPEN (timer resets) |

**Rules:**

- The circuit breaker is **per-process** — each API instance tracks its own Redis health independently.
- When the circuit is OPEN, permission checks use fresh database queries. This is slower but never incorrect.
- Cache invalidation events (role changes, scope changes, permission revocation) always write to PostgreSQL first. The Redis invalidation is best-effort — if Redis is down, the next cache population after recovery will fetch fresh data.
- Sensitive operations (contract approval, credential review, schedule publication, role assignment) **always** verify permissions against PostgreSQL regardless of circuit state. Redis is used only to accelerate read-heavy operations (menu rendering, roster view authorization).
- A sustained Redis outage lasting more than 10 minutes triggers a health alert (Section 7.5).

**Implementation — circuit breaker service:**

```typescript
// src/common/cache/redis-circuit-breaker.service.ts
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Redis } from 'ioredis';

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

interface CircuitBreakerConfig {
  failureThreshold: number;      // consecutive failures to trip → OPEN
  failureWindowMs: number;       // window within which failures are counted
  cooldownMs: number;            // time in OPEN before probing
  sensitiveOpsAlwaysDb: boolean; // sensitive operations bypass cache entirely
}

const DEFAULT_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  failureWindowMs: 30_000,
  cooldownMs: 60_000,
  sensitiveOpsAlwaysDb: true,
};

@Injectable()
export class RedisCircuitBreakerService implements OnModuleInit {
  private readonly logger = new Logger(RedisCircuitBreakerService.name);
  private state: CircuitState = CircuitState.CLOSED;
  private failureTimestamps: number[] = [];
  private lastOpenedAt: number = 0;
  private readonly config: CircuitBreakerConfig;

  constructor(private readonly redis: Redis) {
    this.config = {
      ...DEFAULT_CONFIG,
      failureThreshold: parseInt(process.env.REDIS_CB_FAILURE_THRESHOLD ?? '5'),
      cooldownMs: parseInt(process.env.REDIS_CB_COOLDOWN_MS ?? '60000'),
    };
  }

  async onModuleInit() {
    // Test Redis connectivity on startup
    try {
      await this.redis.ping();
      this.state = CircuitState.CLOSED;
      this.logger.log('Redis connected — circuit CLOSED');
    } catch {
      this.state = CircuitState.OPEN;
      this.lastOpenedAt = Date.now();
      this.logger.warn('Redis unavailable on startup — circuit OPEN, using database fallback');
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  /**
   * Execute a Redis operation with circuit breaker protection.
   * Returns the cached value on success, or null (triggering DB fallback).
   */
  async get<T>(key: string): Promise<T | null> {
    if (this.state === CircuitState.OPEN) {
      if (this.shouldProbe()) {
        return this.probe<T>(key);
      }
      return null; // caller falls back to database
    }

    try {
      const raw = await this.redis.get(key);
      if (this.state === CircuitState.HALF_OPEN) {
        this.transitionTo(CircuitState.CLOSED);
      }
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      this.recordFailure();
      return null;
    }
  }

  /**
   * Set a cached value. Silently ignored when circuit is OPEN.
   */
  async set(key: string, value: any, ttlSeconds: number): Promise<void> {
    if (this.state === CircuitState.OPEN) return;

    try {
      await this.redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      this.recordFailure();
      // Cache write failure is non-fatal — data is in PostgreSQL
    }
  }

  /**
   * Invalidate a cache key. Always attempts the write even if circuit
   * is OPEN, because stale permissions are a security risk.
   */
  async invalidate(key: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch {
      this.logger.warn(`Cache invalidation failed for key ${key} — ` +
        `database is authoritative; cache will refresh on next population`);
    }
  }

  private recordFailure(): void {
    const now = Date.now();
    this.failureTimestamps.push(now);
    // Keep only failures within the window
    this.failureTimestamps = this.failureTimestamps
      .filter(ts => now - ts < this.config.failureWindowMs);

    if (this.failureTimestamps.length >= this.config.failureThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private shouldProbe(): boolean {
    return Date.now() - this.lastOpenedAt >= this.config.cooldownMs;
  }

  private async probe<T>(key: string): Promise<T | null> {
    this.transitionTo(CircuitState.HALF_OPEN);
    try {
      const raw = await this.redis.get(key);
      this.transitionTo(CircuitState.CLOSED);
      return raw ? JSON.parse(raw) : null;
    } catch {
      this.transitionTo(CircuitState.OPEN);
      return null;
    }
  }

  private transitionTo(newState: CircuitState): void {
    if (this.state === newState) return;
    const oldState = this.state;
    this.state = newState;

    if (newState === CircuitState.OPEN) {
      this.lastOpenedAt = Date.now();
      this.logger.warn(`Redis circuit breaker: ${oldState} → OPEN — using database fallback`);
    } else if (newState === CircuitState.CLOSED) {
      this.failureTimestamps = [];
      this.logger.log(`Redis circuit breaker: ${oldState} → CLOSED — cache operational`);
      // Trigger async cache rebuild
      this.rebuildCache().catch(err =>
        this.logger.error(`Cache rebuild failed: ${err.message}`)
      );
    } else {
      this.logger.log(`Redis circuit breaker: ${oldState} → HALF_OPEN — probing`);
    }
  }

  /**
   * Rebuild critical cache entries after Redis recovery.
   * Runs asynchronously — the system operates correctly without it.
   */
  private async rebuildCache(): Promise<void> {
    this.logger.log('Rebuilding permission and menu caches after Redis recovery');
    // Populated on-demand by the next request for each user/role
    // No bulk rebuild needed — cache-miss path populates naturally
  }
}
```

**Implementation — permission service with fallback:**

```typescript
// src/modules/identity/permission-cache.service.ts
@Injectable()
export class PermissionCacheService {
  private static readonly CACHE_TTL = 300; // 5 minutes
  private static readonly CACHE_PREFIX = 'perm:';

  // Operations that ALWAYS query the database regardless of cache state
  private static readonly SENSITIVE_OPS = new Set([
    'contract:approve', 'contract:terminate',
    'credential:review', 'credential:suspend', 'credential:revoke',
    'schedule:publish',
    'role:assign', 'role:revoke',
    'account:create', 'account:disable',
  ]);

  constructor(
    private readonly circuitBreaker: RedisCircuitBreakerService,
    private readonly prisma: PrismaService,
  ) {}

  async hasPermission(
    accountId: number,
    operation: string,
    resourceId?: number,
  ): Promise<boolean> {
    // Sensitive operations always use fresh database query
    if (PermissionCacheService.SENSITIVE_OPS.has(operation)) {
      return this.queryPermissionFromDb(accountId, operation, resourceId);
    }

    // Try cache first (circuit breaker handles Redis state)
    const cacheKey = `${PermissionCacheService.CACHE_PREFIX}${accountId}:${operation}`;
    const cached = await this.circuitBreaker.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    // Cache miss or Redis unavailable — query database
    const result = await this.queryPermissionFromDb(accountId, operation, resourceId);

    // Populate cache for next time (no-op if circuit is OPEN)
    await this.circuitBreaker.set(cacheKey, result, PermissionCacheService.CACHE_TTL);

    return result;
  }

  /**
   * Invalidate all cached permissions for an account.
   * Called on role change, scope change, or session revocation.
   */
  async invalidateAccount(accountId: number): Promise<void> {
    // Pattern-based invalidation
    await this.circuitBreaker.invalidate(
      `${PermissionCacheService.CACHE_PREFIX}${accountId}:*`
    );
    // Database remains authoritative — no data is lost if this fails
  }

  private async queryPermissionFromDb(
    accountId: number,
    operation: string,
    resourceId?: number,
  ): Promise<boolean> {
    // ... existing database permission query logic
  }
}
```

**Implementation — environment configuration:**

```env
# .env.production — Redis circuit breaker section
REDIS_CB_FAILURE_THRESHOLD=5       # consecutive failures to trip OPEN
REDIS_CB_COOLDOWN_MS=60000         # 60s before probing after OPEN
REDIS_CB_FAILURE_WINDOW_MS=30000   # window for counting failures
```

**Implementation — health endpoint extension:**

```typescript
// Extend the existing health service (Section 7.4)
async getRedisHealth(): Promise<RedisHealth> {
  return {
    circuitState:       this.circuitBreaker.getState(),
    lastStateChange:    this.circuitBreaker.getLastTransitionTime(),
    failuresInWindow:   this.circuitBreaker.getRecentFailureCount(),
    uptimePercentage24h: await this.calculateRedisUptime(24),
  };
}

// Alert conditions:
// - circuitState === 'OPEN' for > 10 minutes → Redis outage alert
// - uptimePercentage24h < 99%                → Redis stability warning
// - failuresInWindow > 0 && state === CLOSED → intermittent connectivity
```

**Acceptance criteria for Redis circuit breaker:**

| Criterion | Required evidence |
| :--- | :--- |
| Graceful degradation | Stop Redis; all API requests continue successfully with increased latency; no 500 errors |
| Circuit trips on failures | 5 consecutive Redis timeouts within 30s transition the circuit to OPEN |
| Automatic recovery | Restart Redis; circuit probes and transitions back to CLOSED within 60s; cache repopulates |
| Sensitive ops bypass cache | Contract approval, credential review and schedule publication always query PostgreSQL, even with circuit CLOSED |
| Permission revocation | Revoking a role invalidates the cache immediately; the next request uses fresh database permissions |
| No data loss | Redis crash loses no authoritative data; all permission and menu data reconstructs from PostgreSQL |
| Health visibility | The health endpoint reports circuit state, failure count and 24-hour uptime |

### 9.4 Transaction and concurrency guarantees

**Specification:** The following operations must be atomic (all-or-nothing within a single database transaction):

| Operation | What commits together |
| :--- | :--- |
| Onboarding | Employee + Draft contract + history + audit |
| Account claiming | Invitation consumption + account creation + employee link |
| Credential review | Approved fields + selected evidence version + audit + schedule revalidation |
| Schedule publication | Lock affected employees (consistent order), recheck eligibility, publish assignments, write audit |
| Notifications | Persist event/recipient delivery intent before attempting SMTP |

**Concurrency rules:**

- Retain row locks and constraints for concurrent writes.
- Add bounded retries for transient deadlocks/serialization failures.
- Add request idempotency keys for onboarding, invitation creation and publication — see Section 9.5.
- Store instants in UTC using timezone-aware database columns for new event data. Use explicit date-only values and Asia/Riyadh for employment and credential policy dates.

### 9.5 Request idempotency

**Specification:** Critical state-changing operations support client-generated idempotency keys. A repeated request carrying the same key returns the original result without performing the operation again, preventing duplicate employee records, double invitations and duplicate publications caused by network retries, user double-clicks or concurrent submissions.

**Protected operations:**

| Operation | Risk without idempotency | Key scope |
| :--- | :--- | :--- |
| Employee onboarding | Duplicate Employee Master + Draft contract records | Per actor + Job Number |
| Invitation creation | Multiple invitation emails for the same employee | Per actor + employee ID |
| Contract approval | Double audit entries, conflicting state transitions | Per actor + contract ID |
| Schedule publication | Duplicate assignments, double notifications | Per actor + unit + date window |
| Account registration | Race condition creating multiple accounts for one employee | Per invitation token |

**Rules:**

- The client generates a UUID v4 idempotency key and sends it in the `Idempotency-Key` header.
- The server stores the key, the response status code, a hash of the full response body and a **minimal replay payload** (resource identifiers and status — never the full body, which can contain personal data) in a dedicated table. The key row is committed with the business mutation.
- If a request arrives with a key that already has a stored result, the server returns the stored response immediately without executing the operation. The response includes an `Idempotency-Replayed: true` header.
- If a request arrives with a key that is currently being processed (in-flight) **and its processing lease is still live**, the server returns `409 Conflict` with a `Retry-After` header. If the lease has lapsed (the previous request crashed), this request retakes the key instead of failing — a stuck key can never block a client for the full 24 hours.
- Keys expire after 24 hours — a request with an expired key is treated as a new request.
- Idempotency keys are scoped to the authenticated actor. The same key from different actors is treated as different requests.
- `GET`, `HEAD` and `OPTIONS` requests are inherently idempotent and do not require keys.
- A missing `Idempotency-Key` header on a protected operation returns `400 Bad Request` with a descriptive error.

**Implementation — database schema:**

```sql
-- prisma/migrations/V33_idempotency_keys.sql

CREATE TABLE idempotency_keys (
  id              BIGSERIAL PRIMARY KEY,
  key             UUID NOT NULL,
  actor_id        INTEGER NOT NULL,
  operation       VARCHAR(100) NOT NULL,        -- 'onboarding', 'invitation', 'publication', etc.
  status          VARCHAR(20) NOT NULL DEFAULT 'PROCESSING',  -- 'PROCESSING', 'COMPLETED', 'FAILED'
  request_path    VARCHAR(500) NOT NULL,
  request_hash    VARCHAR(64) NOT NULL,         -- SHA-256 of sanitized request body
  response_code   SMALLINT,
  response_hash   VARCHAR(64),                  -- SHA-256 of response body
  response_body   JSONB,                        -- stored response for replay
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  -- Processing lease: if the request that registered the key dies before
  -- completing, the lease lapses and the key can be retaken (see the guard).
  processing_lease_expires_at TIMESTAMPTZ,

  CONSTRAINT uq_idempotency_key UNIQUE (key, actor_id)
);

CREATE INDEX idx_ik_expires ON idempotency_keys(expires_at) WHERE status != 'COMPLETED';
CREATE INDEX idx_ik_actor   ON idempotency_keys(actor_id, created_at DESC);

-- Cleanup: remove expired keys daily
-- (Executed by the background worker, not a database cron)
```

**Implementation — idempotency guard middleware:**

```typescript
// src/common/idempotency/idempotency.guard.ts
import {
  Injectable, CanActivate, ExecutionContext,
  BadRequestException, ConflictException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';

export const IDEMPOTENT = 'idempotent';
export const Idempotent = (operation: string) =>
  SetMetadata(IDEMPOTENT, operation);

@Injectable()
export class IdempotencyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const operation = this.reflector.get<string>(IDEMPOTENT, context.getHandler());
    if (!operation) return true; // not a protected endpoint

    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    // Safe methods don't need idempotency keys
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;

    const idempotencyKey = req.headers['idempotency-key'];
    if (!idempotencyKey) {
      throw new BadRequestException(
        `Idempotency-Key header is required for ${operation} operations`
      );
    }

    // Validate UUID format
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(idempotencyKey)) {
      throw new BadRequestException('Idempotency-Key must be a valid UUID v4');
    }

    const actorId = req.user?.id;
    if (!actorId) return true; // auth guard will reject

    // Check for existing key
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: {
        key_actorId: { key: idempotencyKey, actorId },
      },
    });

    if (existing) {
      // Key exists — check if expired
      if (existing.expiresAt < new Date()) {
        // Expired key — treat as new request, delete the old one
        await this.prisma.idempotencyKey.delete({ where: { id: existing.id } });
      } else if (existing.status === 'PROCESSING') {
        // Another request is processing this key — unless its lease has lapsed
        // (crashed worker), in which case this request retakes the key.
        const leaseLive =
          existing.processingLeaseExpiresAt != null &&
          existing.processingLeaseExpiresAt > new Date();
        if (leaseLive) {
          throw new ConflictException({
            message: 'A request with this idempotency key is already being processed',
            retryAfter: 2,
          });
        }
        // Lease lapsed — fall through to the upsert below and retake the key.
      } else if (existing.status === 'COMPLETED') {
        // Replay the stored response
        res.setHeader('Idempotency-Replayed', 'true');
        res.status(existing.responseCode).json(existing.responseBody);
        return false; // short-circuit — don't execute the handler
      }
      // FAILED status — allow retry
    }

    // Register the key as PROCESSING
    const requestHash = this.hashBody(req.body);
    await this.prisma.idempotencyKey.upsert({
      where: { key_actorId: { key: idempotencyKey, actorId } },
      create: {
        key: idempotencyKey,
        actorId,
        operation,
        requestPath: req.originalUrl,
        requestHash,
        status: 'PROCESSING',
        processingLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
      update: {
        status: 'PROCESSING',
        requestHash,
        requestPath: req.originalUrl,
        processingLeaseExpiresAt: new Date(Date.now() + 5 * 60 * 1000),
      },
    });

    // Attach key info to request for the interceptor to store the response
    req.idempotencyKey = idempotencyKey;
    req.idempotencyOperation = operation;

    return true;
  }

  private hashBody(body: any): string {
    return createHash('sha256')
      .update(JSON.stringify(body ?? {}))
      .digest('hex');
  }
}
```

**Implementation — response capture interceptor:**

```typescript
// src/common/idempotency/idempotency.interceptor.ts
import {
  Injectable, NestInterceptor, ExecutionContext, CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { PrismaService } from '../../prisma/prisma.service';
import { createHash } from 'crypto';

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();

    if (!req.idempotencyKey) return next.handle();

    return next.handle().pipe(
      tap(async (responseBody) => {
        // Store the successful response for future replays
        await this.prisma.idempotencyKey.update({
          where: {
            key_actorId: {
              key: req.idempotencyKey,
              actorId: req.user.id,
            },
          },
          data: {
            status: 'COMPLETED',
            responseCode: res.statusCode,
            // Minimal replay payload — identifiers only. Storing the full body
            // would keep a second, unlogged copy of personal data for 24 hours
            // (PDPL, Section 8.3).
            responseBody: { id: (responseBody as any)?.id ?? null },
            responseHash: createHash('sha256')
              .update(JSON.stringify(responseBody))
              .digest('hex'),
            completedAt: new Date(),
          },
        }).catch(() => {
          // Non-fatal — the business operation already succeeded
        });
      }),
      catchError(async (error) => {
        // Mark the key as FAILED so it can be retried
        await this.prisma.idempotencyKey.update({
          where: {
            key_actorId: {
              key: req.idempotencyKey,
              actorId: req.user.id,
            },
          },
          data: {
            status: 'FAILED',
            responseCode: error.status ?? 500,
            completedAt: new Date(),
          },
        }).catch(() => {});
        throw error;
      }),
    );
  }
}
```

**Implementation — controller usage example:**

```typescript
// src/modules/workforce/controllers/workforce.controller.ts
@Post('onboard')
@Idempotent('onboarding')  // ← decorator marks this as idempotency-protected
@UseGuards(IdempotencyGuard)
async onboardEmployee(@Body() dto: OnboardEmployeeDto, @Req() req: Request) {
  return this.workforceService.onboardEmployee(dto, req.user.id);
}

// src/modules/identity/controllers/invitation.controller.ts
@Post('invitations')
@Idempotent('invitation')
@UseGuards(IdempotencyGuard)
async createInvitation(@Body() dto: CreateInvitationDto, @Req() req: Request) {
  return this.identityService.createInvitation(dto, req.user.id);
}

// src/modules/scheduling/controllers/scheduling.controller.ts
@Post('publish')
@Idempotent('publication')
@UseGuards(IdempotencyGuard)
async publishSchedule(@Body() dto: PublishScheduleDto, @Req() req: Request) {
  return this.schedulingService.publishSchedule(dto, req.user.id);
}
```

**Implementation — frontend idempotency key generation:**

```typescript
// src/lib/idempotency.ts
import { v4 as uuidv4 } from 'uuid';

/**
 * Generate an idempotency key and attach it to the request.
 * For form submissions, generate the key when the form opens
 * and reuse it on retry — this prevents duplicate submissions
 * even if the user double-clicks the submit button.
 */
export function createIdempotencyKey(): string {
  return uuidv4();
}

/**
 * Enhanced apiFetch that includes idempotency key for protected operations.
 */
export async function idempotentFetch(
  path: string,
  idempotencyKey: string,
  opts: RequestInit = {},
) {
  const headers = new Headers(opts.headers);
  headers.set('Idempotency-Key', idempotencyKey);

  const response = await apiFetch(path, { ...opts, headers });

  // Log if this was a replayed response
  if (response.headers.get('Idempotency-Replayed') === 'true') {
    console.info(`Request replayed (idempotent): ${path}`);
  }

  return response;
}

// Usage in React components:
// const idempotencyKey = useRef(createIdempotencyKey());
// const handleSubmit = () => idempotentFetch('/api/v1/workforce/onboard', idempotencyKey.current, { ... });
// Reset key after confirmed success: idempotencyKey.current = createIdempotencyKey();
```

**Implementation — expired key cleanup (worker):**

```typescript
// src/common/idempotency/idempotency-cleanup.worker.ts
const IDEMPOTENCY_CLEANUP_LOCK_ID = 100005;

@Injectable()
export class IdempotencyCleanupWorker {
  // Run daily at 04:00 Asia/Riyadh (01:00 UTC)
  @Cron('0 1 * * *')
  async cleanupExpiredKeys() {
    const acquired = await this.tryLock(IDEMPOTENCY_CLEANUP_LOCK_ID);
    if (!acquired) return;

    try {
      const result = await this.prisma.$executeRaw`
        DELETE FROM idempotency_keys
        WHERE expires_at < now()
           OR (status = 'PROCESSING'
               AND processing_lease_expires_at < now() - interval '1 hour')
      `;
      this.logger.log(`Cleaned up ${result} expired idempotency keys`);
    } finally {
      await this.releaseLock(IDEMPOTENCY_CLEANUP_LOCK_ID);
    }
  }
}
```

**Acceptance criteria for request idempotency:**

| Criterion | Required evidence |
| :--- | :--- |
| Duplicate prevention | Submitting onboarding with the same idempotency key twice creates exactly one employee record; second request returns original response with `Idempotency-Replayed: true` |
| Concurrent protection | Two simultaneous requests with the same key: one succeeds, the other receives `409 Conflict` |
| Missing key rejection | A `POST` to a protected endpoint without `Idempotency-Key` header returns `400 Bad Request` |
| Key expiry | A key older than 24 hours is treated as a new request |
| Failed retry | A request that failed (500) with a key can be retried with the same key and succeeds |
| Publication idempotency | Publishing the same unit/date schedule twice with the same key creates assignments only once |
| Frontend integration | Double-clicking a submit button does not create duplicate records |
| Cleanup | Expired keys are removed daily; table does not grow unbounded |

---

## 10. Deployment, migrations and operations

### 10.1 Migration system

**Specification:** The system uses ordered raw SQL migrations managed through Prisma.

**Rules:**

- Fresh production setup applies all migrations without demo users/nurses, then creates a first administrator using explicit environment credentials.
- Demo test setup uses the `--include-demo` flag with additional seed migrations.
- The runner compares checksums, rejects drift and skips already-applied migrations. Historical SQL must not be edited to conceal a mismatch.
- Take a backup and rehearse restoration/upgrade on staging before touching live data.

**Migration numbering:**

The baseline application occupies V01–V26. To resolve the V-number collisions found in v2.8.0, the following authoritative numbering is established. All implementation-spec migrations must use these slots:

| Migration | Purpose | Section | Status |
| :--- | :--- | :--- | :--- |
| V27 | Position directory & FK constraints | 3.1.1 | Implementation spec |
| V28 | Hospital org structure & bed capacity | 2.9 | Implementation spec |
| V29 | Credential catalog CRUD | 5.1 | Implementation spec |
| V30 | SCFHS integration | 5.4 | Implementation spec |
| V31 | Grace periods | 6.1.1 | Implementation spec |
| V32 | Upload quarantine & scan schema | 5.3.2 | Implementation spec |
| V33 | Idempotency keys | 9.5 | Implemented |
| V34 | Push notifications | 7.6 | Implementation spec |
| V35 | PDPL controls (encryption/rights) | 8.3 | Implementation spec |
| V36 | Bulletproof onboarding (secure function) | 3.1 | Implementation spec |
| V37 | PII blind indexing (searchability) | 8.3 | Implementation spec |
| V38 | Crypto-shredding (erasure vs audit) | 8.3 / 9.1 | Implementation spec |
| V39 | Materialized eligibility state | 6.1 | Implementation spec |
| V40 | SCFHS resilience & sync state | 5.4 | Implementation spec |
| V41 | Secure evidence vault & integrity | 5.3 | Implementation spec |
| V42 | Admin guardrails (PAM & four-eyes) | 8.1 / 3.5 | Implementation spec |
| V43 | Deep observability & business health | 10.8 | Implementation spec |
| V44 | Operational survivability (break-glass/shadow) | 10.9 | Implementation spec |
| V45 | Enterprise integration (FHIR/attendance/export) | 14.1–14.3 | Implementation spec |
| V46 | Request audit log | 9.2 | Implementation spec |
| V47 | Legacy migration bridge (staging/scrubbing) | 10.10 | Implementation spec |
| V48 | Policy transitions & emergency waivers | 6.1.2 | Implementation spec |
| V49 | Worker leases (replaces session-scoped advisory locks) | 10.3 | Implementation spec |

**Implementation — V37 PII blind indexing:**

```sql
-- prisma/migrations/V37_pii_blind_indexing.sql

-- 1. Add blind index columns to employees. The *_blind_key_version column
--    records which pepper version produced the digest, so the pepper can be
--    rotated by writing new digests and lazily re-indexing (Section 8.3.4).
ALTER TABLE employees
  ADD COLUMN iqama_blind_index VARCHAR(64),
  ADD COLUMN passport_blind_index VARCHAR(64),
  ADD COLUMN iqama_blind_key_version    SMALLINT NOT NULL DEFAULT 1,
  ADD COLUMN passport_blind_key_version SMALLINT NOT NULL DEFAULT 1;

-- 2. Add blind index columns to credentials (tracking_data is JSONB,
-- so we add separate columns for high-frequency search fields)
ALTER TABLE credentials
  ADD COLUMN scfhs_reg_blind_index VARCHAR(64),
  ADD COLUMN scfhs_blind_key_version SMALLINT NOT NULL DEFAULT 1;

-- 3. Create B-Tree indexes for O(1) lookup performance
CREATE INDEX idx_emp_iqama_blind ON employees(iqama_blind_index);
CREATE INDEX idx_emp_passport_blind ON employees(passport_blind_index);
CREATE INDEX idx_cred_scfhs_blind ON credentials(scfhs_reg_blind_index);
```

**Implementation — V38 crypto-shredding:**

```sql
-- prisma/migrations/V38_crypto_shredding.sql

-- 1. Create the User Encryption Key Store
-- This table stores the unique key used to encrypt a specific user's PII in logs
CREATE TABLE user_encryption_keys (
  user_id             INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  encrypted_user_key  TEXT NOT NULL,     -- The user's key, encrypted by the Master System Key
  key_version         INTEGER NOT NULL DEFAULT 1,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_uek_user ON user_encryption_keys(user_id);

-- 2. Update audit_entries to support encrypted payloads
-- The 'changes' column will now store encrypted JSON for PII-sensitive events
ALTER TABLE audit_entries
  ADD COLUMN is_encrypted BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN encryption_key_id INTEGER REFERENCES user_encryption_keys(user_id);
```

**Implementation — V39 materialized eligibility:**

```sql
-- prisma/migrations/V39_materialized_eligibility.sql

-- 1. Create the Materialized State table
-- This transforms eligibility from a calculation into a stored state
CREATE TABLE employee_eligibility_state (
  employee_id        INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  status             VARCHAR(30) NOT NULL
    CHECK (status IN ('ELIGIBLE', 'ELIGIBLE_WITH_GRACE', 'INELIGIBLE')),
  reasons            JSONB NOT NULL DEFAULT '[]', -- Cached list of failure/grace reasons
  last_calculated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_event   VARCHAR(50),                  -- e.g., 'CONTRACT_UPDATE', 'DAILY_TRANSITION'

  CONSTRAINT uq_eligibility_employee UNIQUE (employee_id)
);

-- 2. Index for fast roster filtering (find all eligible nurses in a unit)
CREATE INDEX idx_eligibility_status ON employee_eligibility_state(status);

-- 3. Initial population: Calculate current state for all active employees
INSERT INTO employee_eligibility_state (employee_id, status, reasons, last_calculated_at)
SELECT
    e.id,
    res.eligibility_type,
    res.reasons,
    now()
FROM employees e
CROSS JOIN LATERAL check_nurse_eligibility(e.id, CURRENT_DATE) res
WHERE e.deleted_at IS NULL;
```

**Implementation — V40 SCFHS resilience:**

```sql
-- prisma/migrations/V40_scfhs_resilience.sql

-- 1. Add sync tracking to credentials
ALTER TABLE credentials
  ADD COLUMN sync_status VARCHAR(30) DEFAULT 'UNKNOWN'
    CHECK (sync_status IN ('SYNCED', 'STALE', 'FAILED', 'PENDING')),
  ADD COLUMN last_sync_attempt TIMESTAMPTZ,
  ADD COLUMN sync_error_count INTEGER DEFAULT 0;

-- 2. Create a Circuit Breaker state table to track API health
CREATE TABLE external_api_health (
  api_name        VARCHAR(50) PRIMARY KEY,
  is_available    BOOLEAN DEFAULT true,
  failure_count   INTEGER DEFAULT 0,
  last_failure_at TIMESTAMPTZ,
  recovery_time   TIMESTAMPTZ
);

-- Seed the health check for SCFHS
INSERT INTO external_api_health (api_name, is_available) VALUES ('SCFHS', true);

CREATE INDEX idx_cred_sync_status ON credentials(sync_status);
```

**Implementation — V41 secure evidence vault:**

```sql
-- prisma/migrations/V41_secure_evidence_vault.sql

-- 1. Update evidence table to support private storage and integrity checks
ALTER TABLE credential_evidence
  ADD COLUMN storage_key VARCHAR(500) NOT NULL, -- Unique identifier in private storage
  ADD COLUMN file_checksum VARCHAR(64) NOT NULL, -- SHA-256 hash for tampering detection
  ADD COLUMN is_orphaned BOOLEAN DEFAULT false;

-- 2. Create index for the cleanup worker
CREATE INDEX idx_evidence_storage_key ON credential_evidence(storage_key);
CREATE INDEX idx_evidence_orphaned ON credential_evidence(is_orphaned) WHERE is_orphaned = true;

-- 3. Migration of existing BLOBs to storage_key (Conceptual)
-- UPDATE credential_evidence SET storage_key = 'legacy_' || id, file_checksum = '...';
```

**Implementation — V42 admin guardrails:**

```sql
-- prisma/migrations/V42_admin_guardrails.sql

-- 1. High-Impact Approval Table
-- Stores actions that require dual-authorization (Four-Eyes Principle)
CREATE TABLE admin_approval_requests (
  id                BIGSERIAL PRIMARY KEY,
  initiator_id      INTEGER NOT NULL REFERENCES accounts(id),
  approver_id       INTEGER REFERENCES accounts(id),
  action_type       VARCHAR(50) NOT NULL, -- e.g., 'PROMOTED_TO_ADMIN', 'ELIGIBILITY_RULE_CHANGE'
  request_payload   JSONB NOT NULL,       -- The data to be changed
  status            VARCHAR(20) NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'EXECUTED')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at       TIMESTAMPTZ,
  rejection_reason  TEXT
);

-- Prevent a second identical request while one is still pending.
-- (created_at has microsecond precision, so a UNIQUE constraint that includes
-- it would never fire.)
CREATE UNIQUE INDEX uq_admin_request_pending
  ON admin_approval_requests(initiator_id, action_type)
  WHERE status = 'PENDING';

-- 2. Privileged Access Management (PAM) Session Table
-- Tracks Just-In-Time (JIT) elevation of privileges
CREATE TABLE privileged_sessions (
  user_id           INTEGER PRIMARY KEY REFERENCES accounts(id),
  elevated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  reason            TEXT NOT NULL,
  authorized_by     INTEGER REFERENCES accounts(id),

  CONSTRAINT check_expiry CHECK (expires_at > elevated_at)
);

CREATE INDEX idx_admin_req_status ON admin_approval_requests(status);
CREATE INDEX idx_pam_expiry ON privileged_sessions(expires_at);
```

**Implementation — V43 deep observability:**

```sql
-- prisma/migrations/V43_deep_observability.sql

-- 1. System Health Metrics Store
-- Tracks the "Vital Signs" of business logic
CREATE TABLE system_health_metrics (
  metric_name        VARCHAR(100) PRIMARY KEY,
  current_value      TEXT NOT NULL,
  status             VARCHAR(20) NOT NULL
    CHECK (status IN ('HEALTHY', 'WARNING', 'CRITICAL')),
  last_updated       TIMESTAMPTZ NOT NULL DEFAULT now(),
  threshold_value    TEXT,
  alert_message      TEXT
);

-- 2. Consistency Audit Log
-- Tracks when the "Materialized State" drifts from the "Real Calculation"
CREATE TABLE consistency_audit_log (
  id                BIGSERIAL PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  expected_status   VARCHAR(30), -- Result from canonical engine
  actual_status     VARCHAR(30), -- Result found in state table
  drift_detected    BOOLEAN NOT NULL,
  resolved_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed critical business metrics
INSERT INTO system_health_metrics (metric_name, current_value, status) VALUES
('scfhs_sync_freshness', 'UNKNOWN', 'WARNING'),
('eligibility_drift_rate', '0%', 'HEALTHY'),
('backup_verification_age', 'UNKNOWN', 'WARNING'),
('pam_elevation_count', '0', 'HEALTHY');

CREATE INDEX idx_audit_drift ON consistency_audit_log(drift_detected, created_at);
```

**Implementation — V44 operational survivability:**

```sql
-- prisma/migrations/V44_operational_survivability.sql

-- 1. Break-Glass Audit Log (Siren)
-- Records every use of the Root account; non-deletable
CREATE TABLE break_glass_events (
  id                BIGSERIAL PRIMARY KEY,
  actor_id          INTEGER NOT NULL,
  access_timestamp  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason            TEXT NOT NULL,
  ip_address        INET NOT NULL,
  event_type        VARCHAR(30) DEFAULT 'Siren_Activated',
  resolved_at       TIMESTAMPTZ
);

-- 2. Eligibility Shadow Mode Table
-- Records discrepancies between "Active" and "Candidate" logic
CREATE TABLE eligibility_shadow_log (
  id                BIGSERIAL PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  active_status     VARCHAR(30), -- Current Production result
  candidate_status  VARCHAR(30), -- Result from new logic version
  discrepancy       BOOLEAN NOT NULL,
  logic_version     VARCHAR(20) NOT NULL, -- e.g., 'v2.1'
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shadow_discrepancy ON eligibility_shadow_log(discrepancy, logic_version);
```

**Implementation — V45 enterprise integration:**

```sql
-- prisma/migrations/V45_enterprise_integration.sql

-- 1. Real-time Attendance Feed
-- Stores clock-in/out events from the hospital badge system
CREATE TABLE attendance_events (
  id                BIGSERIAL PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  event_type        VARCHAR(20) NOT NULL CHECK (event_type IN ('CLOCK_IN', 'CLOCK_OUT', 'BREAK_START', 'BREAK_END')),
  event_timestamp   TIMESTAMPTZ NOT NULL DEFAULT now(),
  device_id         VARCHAR(50), -- ID of the badge reader/terminal
  location_code     VARCHAR(50), -- Physical location of the reader

  CONSTRAINT uq_attendance_event UNIQUE (employee_id, event_timestamp)
);

CREATE INDEX idx_att_emp_time ON attendance_events(employee_id, event_timestamp DESC);

-- 2. FHIR Mapping Table
-- Maps internal IDs to Global FHIR Resource IDs (Practitioner/PractitionerRole)
CREATE TABLE fhir_resource_mapping (
  internal_id       VARCHAR(100) NOT NULL, -- e.g., 'Employee:123'
  fhir_resource_id  VARCHAR(100) NOT NULL, -- The global FHIR UUID
  resource_type     VARCHAR(50) NOT NULL, -- e.g., 'Practitioner'
  last_synced_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (internal_id)
);
```

**Implementation — V47 legacy migration bridge:**

```sql
-- prisma/migrations/V47_migration_bridge.sql

-- 1. Create a separate schema for the migration sandbox
-- This keeps "dirty" legacy data away from the production tables
CREATE SCHEMA migration_staging;

-- 2. Create raw import tables (No constraints, no FKs, all TEXT)
-- This allows us to import any CSV/Excel data regardless of quality
CREATE TABLE migration_staging.raw_employees (
  row_id        SERIAL PRIMARY KEY,
  raw_name      TEXT,
  raw_job_num   TEXT,
  raw_position  TEXT,
  raw_unit      TEXT,
  raw_email     TEXT,
  import_status VARCHAR(20) DEFAULT 'PENDING' -- PENDING, VALIDATED, ERROR
);

CREATE TABLE migration_staging.raw_contracts (
  row_id        SERIAL PRIMARY KEY,
  emp_job_num   TEXT,
  start_date    TEXT,
  end_date      TEXT,
  import_status VARCHAR(20) DEFAULT 'PENDING'
);

CREATE TABLE migration_staging.raw_evidence (
  row_id        SERIAL PRIMARY KEY,
  emp_job_num   TEXT,
  file_path     TEXT,
  template_code TEXT,
  import_status VARCHAR(20) DEFAULT 'PENDING'
);

-- 3. Validation Log for HR review
CREATE TABLE migration_validation_errors (
  id                BIGSERIAL PRIMARY KEY,
  staging_table     VARCHAR(50),
  row_id            INTEGER,
  error_message     TEXT,
  severity          VARCHAR(10) CHECK (severity IN ('WARN', 'BLOCK')),
  resolved          BOOLEAN DEFAULT false,
  created_at        TIMESTAMPTZ DEFAULT now()
);

-- 4. Audit trail for the temporary migration role (Section 10.10).
-- Every statement executed by nurseapp_migration_admin is recorded here.
CREATE TABLE migration_audit_log (
  id           BIGSERIAL PRIMARY KEY,
  actor_role   VARCHAR(50) NOT NULL DEFAULT 'nurseapp_migration_admin',
  action       VARCHAR(100) NOT NULL,
  target_table VARCHAR(50) NOT NULL,
  row_count    INTEGER,
  statement    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. Lookup tables and mapper functions used by the Stage 3 commit.
-- HR maintains the mappings before the commit stage runs; unmapped values
-- are flagged in migration_validation_errors and block the commit.
CREATE TABLE migration_staging.unit_map (
  raw_unit  TEXT PRIMARY KEY,
  unit_code VARCHAR(20) NOT NULL REFERENCES nursing_units(code)
);

CREATE TABLE migration_staging.position_map (
  raw_position  TEXT PRIMARY KEY,
  position_code VARCHAR(20) NOT NULL REFERENCES position_directory(code)
);

CREATE OR REPLACE FUNCTION map_unit(raw TEXT) RETURNS INTEGER AS $$
  SELECT nu.id
  FROM migration_staging.unit_map um
  JOIN nursing_units nu ON nu.code = um.unit_code
  WHERE um.raw_unit = raw;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public;

CREATE OR REPLACE FUNCTION map_pos(raw TEXT) RETURNS VARCHAR AS $$
  SELECT position_code
  FROM migration_staging.position_map
  WHERE raw_position = raw;
$$ LANGUAGE sql STABLE SET search_path = pg_catalog, public;
```

**Implementation — V48 policy transitions & emergency waivers:**

```sql
-- prisma/migrations/V48_policy_transitions.sql

-- 1. Update credential requirements to support a "Transition Window"
ALTER TABLE credential_requirements
  ADD COLUMN policy_status VARCHAR(20) DEFAULT 'MANDATORY'
    CHECK (policy_status IN ('MANDATORY', 'TRANSITION')),
  ADD COLUMN transition_deadline TIMESTAMPTZ;

-- 2. Create the Emergency Waiver table
-- Allows a supervisor to override ineligibility for a short window
CREATE TABLE credential_waivers (
  id                BIGSERIAL PRIMARY KEY,
  employee_id       INTEGER NOT NULL REFERENCES employees(id),
  template_id       INTEGER NOT NULL REFERENCES credential_templates(id),
  waived_by         INTEGER NOT NULL REFERENCES accounts(id),
  expiry_date       TIMESTAMPTZ NOT NULL,
  reason            TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The 72-hour maximum waiver window (Section 6.1.2) is enforced in the
  -- database, not only in the API.
  CONSTRAINT chk_waiver_max_window
    CHECK (expiry_date <= created_at + interval '72 hours'),
  CONSTRAINT chk_waiver_future
    CHECK (expiry_date > created_at)
);

CREATE INDEX idx_waiver_emp_template ON credential_waivers(employee_id, template_id);
CREATE INDEX idx_waiver_expiry ON credential_waivers(expiry_date);
```

**Implementation — production environment setup:**

Use `.env.production.example` as the starting template. The production Docker Compose template (Section 2.2) separates migration, API, worker and database services. Mock mode is rejected in production.

### 10.2 Separate background worker

**Specification:** The notification scanner and SMTP worker run in a separate process from the API. The API process must not register any `@Cron` providers. The worker process does not listen on any HTTP port.

**Implementation — worker entry point:**

```typescript
// src/main-worker.ts
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  // No app.listen() — this is NOT an HTTP server

  const logger = app.get(Logger);
  logger.log('Worker started — schedulers and SMTP processor active');

  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received — draining active jobs...');
    await app.close();
    process.exit(0);
  });
}

bootstrap();
```

**Implementation — worker module:**

```typescript
// src/worker.module.ts
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { CredentialsModule } from './modules/credentials/credentials.module';
import { ScfhsModule } from './modules/credentials/scfhs/scfhs.module';       // SCFHS nightly sync
import { GracePeriodModule } from './modules/credentials/grace-period.module'; // grace expiry scanning
import { QuarantineModule } from './modules/credentials/quarantine/quarantine.module'; // upload scanning
import { PrismaModule } from './prisma/prisma.module';
import { AuditModule } from './modules/audit/audit.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),  // enables @Cron decorators HERE only
    PrismaModule,
    AuditModule,
    NotificationsModule,
    ContractsModule,
    CredentialsModule,
    ScfhsModule,               // registers ScfhsSyncWorker @Cron job
    GracePeriodModule,         // provides GracePeriodService (called by daily scan)
    QuarantineModule,          // registers QuarantineScanWorker @Cron job
  ],
})
export class WorkerModule {}
```

**Implementation — disable schedulers in the API:**

Remove `ScheduleModule.forRoot()` from `AppModule`:

```typescript
// src/app.module.ts — modified
@Module({
  imports: [
    // ScheduleModule.forRoot(),  ← DELETE THIS LINE
    PrismaModule,
    IdentityModule,
    WorkforceModule,
    ContractsModule,
    // ... other API modules
  ],
})
```

### 10.3 Advisory locks for multi-worker safety

**Specification:** Exactly one worker instance may run each scheduled job at a time. Workers acquire a **lease** from the `worker_leases` table (V49) before starting, renew it with a heartbeat while running, and release it on completion. A lease that stops being renewed expires and can be taken over, so a crashed worker never blocks a job indefinitely.

**Correction applied in 2.8.7.** Earlier revisions used session-scoped `pg_try_advisory_lock`. That pattern is unsafe behind a connection pool: Prisma may route the acquire and release calls to different pooled connections, and a crash leaves the lock held on a connection that returns to the pool. The advisory-lock helper shown at the end of this section is retained only as legacy reference — all workers use the lease service below. The existing advisory-lock identifiers (100001–100007) are reused as lease keys so code and runbooks that reference them stay valid.

**Implementation — worker lease service (V49, canonical):**

```sql
-- prisma/migrations/V49_worker_leases.sql
CREATE TABLE worker_leases (
  job_name      VARCHAR(100) PRIMARY KEY,   -- e.g. 'notifications.daily_scan'
  holder_id     UUID         NOT NULL,      -- worker instance identity
  acquired_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  heartbeat_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,      -- heartbeat_at + lease duration
  lease_seconds INTEGER      NOT NULL DEFAULT 300
);

CREATE INDEX idx_worker_leases_expiry ON worker_leases(expires_at);
```

```typescript
// src/common/worker-lease/worker-lease.service.ts
@Injectable()
export class WorkerLeaseService {
  private readonly holderId = randomUUID(); // one identity per worker process

  /**
   * Runs `job` only if this instance can take the lease for `jobName`.
   * The heartbeat keeps the lease alive while the job runs; if the process
   * dies, the lease expires and another instance takes over on its next run.
   */
  async withLease(
    jobName: string,
    leaseSeconds: number,
    job: () => Promise<void>,
  ): Promise<boolean> {
    // Take the lease only if it is free, expired, or already ours.
    const taken = await this.prisma.$executeRaw`
      INSERT INTO worker_leases (job_name, holder_id, expires_at, lease_seconds)
      VALUES (${jobName}, ${this.holderId},
              now() + make_interval(secs => ${leaseSeconds}), ${leaseSeconds})
      ON CONFLICT (job_name) DO UPDATE
        SET holder_id    = EXCLUDED.holder_id,
            acquired_at  = now(),
            heartbeat_at = now(),
            expires_at   = EXCLUDED.expires_at
        WHERE worker_leases.holder_id = ${this.holderId}
           OR worker_leases.expires_at < now()
    `;
    if (taken === 0) return false; // another live worker holds the lease

    const heartbeat = setInterval(() => {
      void this.prisma.$executeRaw`
        UPDATE worker_leases
        SET heartbeat_at = now(),
            expires_at   = now() + make_interval(secs => ${leaseSeconds})
        WHERE job_name = ${jobName} AND holder_id = ${this.holderId}
      `;
    }, Math.max(1000, (leaseSeconds * 1000) / 3));

    try {
      await job();
      return true;
    } finally {
      clearInterval(heartbeat);
      await this.prisma.$executeRaw`
        DELETE FROM worker_leases
        WHERE job_name = ${jobName} AND holder_id = ${this.holderId}
      `;
    }
  }
}
```

**Usage:**

```typescript
@Cron('0 3 * * *')
async dailyScan() {
  await this.workerLease.withLease('notifications.daily_scan', 900, async () => {
    await this.scanContractExpiries();    // 90-day window
    await this.scanCredentialExpiries();  // 60-day window + expired
    await this.gracePeriodService.expireGraceWindows();
  });
}
```

**Lease keys in use:** `notifications.daily_scan` (900 s), `notifications.smtp_queue` (120 s), `scfhs.nightly_sync` (1800 s), `credentials.grace_expiry` (600 s), `idempotency.cleanup` (300 s), `backup.freshness_check` (600 s), `quarantine.scan` (300 s).

**Implementation — legacy advisory-lock worker (SUPERSEDED by the V49 lease service above; retained for reference only):**

```typescript
// src/modules/notifications/notification.worker.ts
const DAILY_SCAN_LOCK_ID  = 100001;
const SMTP_WORKER_LOCK_ID = 100002;
// Remaining legacy lock IDs: 100003 SCFHS sync, 100004 grace expiry,
// 100005 idempotency cleanup, 100006 backup monitor, 100007 quarantine scan.
// These are retained as lease keys for the V49 service (Section 10.3) and are
// no longer used as session-scoped advisory locks.

@Injectable()
export class NotificationWorker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gracePeriodService: GracePeriodService,
  ) {}

  // Daily scan at 06:00 Asia/Riyadh = 03:00 UTC
  @Cron('0 3 * * *')
  async dailyScan() {
    const acquired = await this.tryLock(DAILY_SCAN_LOCK_ID);
    if (!acquired) return; // another worker has it

    try {
      await this.scanContractExpiries();   // 90-day window
      await this.scanCredentialExpiries();  // 60-day window + expired
      await this.gracePeriodService.expireGraceWindows(); // close expired grace windows and trigger revalidation
    } finally {
      await this.releaseLock(DAILY_SCAN_LOCK_ID);
    }
  }

  // SMTP delivery every 60 seconds
  @Cron('* * * * *')
  async processEmailQueue() {
    const acquired = await this.tryLock(SMTP_WORKER_LOCK_ID);
    if (!acquired) return;

    try {
      await this.deliverPendingEmails();
    } finally {
      await this.releaseLock(SMTP_WORKER_LOCK_ID);
    }
  }

  // SUPERSEDED (2.8.7): session-scoped advisory locks — safe only on a
  // single dedicated connection. Migrate to WorkerLeaseService.withLease (V49).
  private async tryLock(lockId: number): Promise<boolean> {
    const result = await this.prisma.$queryRaw`
      SELECT pg_try_advisory_lock(${lockId}) AS acquired
    `;
    return result[0].acquired;
  }

  private async releaseLock(lockId: number) {
    await this.prisma.$queryRaw`
      SELECT pg_advisory_unlock(${lockId})
    `;
  }
}
```

**Outcomes:**

- Fault isolation: a worker crash does not take down the API.
- Bounded recovery: a crashed worker's lease expires within its lease duration, so the next scheduled run takes over without manual intervention.
- Independent scaling: multiple API instances behind a load balancer without duplicate schedulers.
- Missed-run recovery: window-based queries catch up on the next run. Unique event keys prevent duplicate records.
- Zero business logic duplication: both entry points import the same modules.

### 10.4 Deployment pipeline and blue/green strategy — planned

**Specification:** The CI/CD pipeline follows this sequence:

1. Commit → dependency/secret checks → lint/type checks → unit tests.
2. PostgreSQL migration and integration tests (on production-target versions).
3. Application build → staging deployment → browser acceptance.
4. Approved production release.

**Rules:**

- Test against the same Node and PostgreSQL versions used in production. The baseline was verified on Node 24 / PostgreSQL 17.11 but production targets Node 20 / PostgreSQL 15 — these must be validated separately.
- Pin deployable images by immutable identifiers and run migrations once per release.
- Use backward-compatible additive migrations. Keep schema rollback planning separate from application rollback — restoring an older API image does not undo a database change.

**Blue/green deployment (target architecture):**

To achieve zero-downtime updates, the system targets a blue/green deployment pattern:

- **Parallel environments** — two identical production environments exist: Blue (current live version) and Green (new version).
- **Traffic switching** — a load balancer (e.g., Nginx or AWS ALB) routes 100% of traffic to Blue.
- **Deployment flow:**
  1. Deploy the new version to the Green environment.
  2. Run smoke tests and health checks on Green while it is still private.
  3. Gradually shift traffic (10% → 50% → 100%) from Blue to Green.
  4. If any error spike is detected, the load balancer immediately rolls back traffic to Blue.
- **Database compatibility** — to prevent crashes during the switch, all migrations must be additive. No columns are deleted or renamed in a single release. Breaking changes are handled via the API versioning strategy (Section 2.2).
- **Pipeline** — Commit → CI Build → Deploy to Green → Health Check → Traffic Shift → Decommission Blue.

**Note:** Blue/green deployment requires duplicate infrastructure. For the initial single-hospital pilot, a simpler rolling update with brief maintenance window is acceptable. Blue/green is the target for multi-unit and production-scale deployments.

### 10.5 Production operations — planned

**Specification:**

- Use separate development, staging and production environments.
- For a pilot: a private application host running proxy/frontend, API and worker containers plus a separate database host.
- Centralize structured logs, request IDs, API error rates, latency, database pool saturation, failed audits, worker heartbeat, oldest pending notification, exhausted retries, storage growth and backup freshness.
- Avoid private document contents and tokens in telemetry.

**Proposed performance targets (require hospital agreement and testing):**

| Target | Value | Definition |
| :--- | :--- | :--- |
| API latency | p95 < 500 ms | 95% of routine interactive reads complete within 500 ms |
| Recovery point | 15 minutes | Maximum acceptable loss of recent data |
| Recovery time | 4 hours | Maximum duration to restore service |

### 10.6 Backup and disaster recovery

**Specification:** The system implements automated backup, point-in-time recovery and a tested restore procedure to meet the proposed RPO (15 minutes) and RTO (4 hours) targets. All backup and recovery operations run without application downtime.

**Backup architecture:**

```mermaid
flowchart TB
    PG[(PostgreSQL Primary)] -->|Continuous WAL archiving| WAL[WAL Archive Storage]
    PG -->|Nightly full backup| FB[Full Backup Storage]
    DS[Document Storage] -->|Nightly sync| DBS[Document Backup Storage]
    FB --> ES[(Encrypted Backup Storage)]
    WAL --> ES
    DBS --> ES
    ES -->|Tested monthly| RP[Restore Procedure]
    RP --> SG[(Staging / DR Instance)]
```

**Backup strategy — three tiers:**

| Tier | Method | Frequency | Retention | RPO achieved |
| :--- | :--- | :--- | :--- | :--- |
| Continuous WAL archiving | PostgreSQL WAL streaming to encrypted storage (`archive_timeout = 300`) | Continuous while active; force-archived every 5 minutes when idle | 7 days of WAL segments | ≤ 5 minutes (bounded by `archive_timeout`; ≈ 1 minute under continuous write load) |
| Full base backup | `pg_basebackup` compressed snapshot | Nightly at 01:00 Asia/Riyadh (22:00 UTC) | 30 days rolling | 24 hours (without WAL); ≤ 5 minutes (with WAL, bounded as above) |
| Document evidence backup | Incremental rsync of document storage directory | Nightly at 01:30 Asia/Riyadh (22:30 UTC) | 30 days rolling, aligned with database backups | 24 hours |

**Implementation — WAL archiving configuration:**

```ini
# postgresql.conf — WAL archiving for point-in-time recovery (PITR)
wal_level = replica                        # required for PITR
archive_mode = on
archive_command = '/usr/local/bin/wal-archive.sh %p %f'
archive_timeout = 300                      # force archive every 5 minutes even without activity

# Recommended WAL settings for a workforce application
max_wal_senders = 3                        # allow streaming replication connections
wal_keep_size = 1GB                        # retain recent WAL for streaming lag
```

**Correction applied in 2.8.7b (review finding F-23).** Four defects in the backup scripts of earlier revisions are fixed below:

1. `pg_basebackup --format=tar` writes a **directory** containing `base.tar.gz` (plus `pg_wal.tar.gz`), not a single `${BACKUP_FILE}.tar.gz` file. The old script then encrypted a path that never existed. The archive is now packed before encryption.
2. **Correction of the correction (verified by execution on the deployment target, PostgreSQL 15.19, 2026-09-18).** An earlier draft of this revision asserted that "`--gzip` is not a `pg_basebackup` option" and that bare `--compress=6` was superseded. Both statements are false. Executed on PostgreSQL 15.19: `--format=tar --gzip` succeeds, `--format=tar --compress=6` succeeds, and `--format=tar --compress=gzip:6` succeeds — all three produce `base.tar.gz`. PostgreSQL 15 and 16 documentation lists `-z, --gzip`, `-Z level, --compress=level` and `-Z [{client|server}-]method[:detail]` as simultaneously valid; the `METHOD[:DETAIL]` form is an addition, not a replacement. The scripts therefore keep `--compress=gzip:6` for clarity and forward-compatibility, but this is recorded as a **clarity change, not a functional defect**. F-23's functional defects are items 1, 3 and 4.
3. Encryption used GPG **public-key** (`--recipient-file`) while decryption used `--passphrase-file` — an invalid combination. Restore now uses a dedicated keyring holding the private key, on the restore host only.
4. `restore_command` redirected decrypt output straight into `%p`, leaving a zero-length WAL file when a segment was missing. A wrapper script now returns non-zero without creating the file.

**Implementation — WAL archive script:**

```bash
#!/bin/bash
# /usr/local/bin/wal-archive.sh
# Archives WAL segments to encrypted backup storage
# Called by PostgreSQL archive_command with %p (source path) and %f (filename).
# PostgreSQL retries archive_command until it succeeds, so this script must
# never leave a partial file behind: encrypt to a temporary path and move it
# into place only after the envelope check passes.

set -euo pipefail

SOURCE_PATH="$1"
WAL_FILENAME="$2"
BACKUP_DIR="${BACKUP_STORAGE_PATH}/wal"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_PATH}"   # public key — backup host only

mkdir -p "${BACKUP_DIR}"

TARGET="${BACKUP_DIR}/${WAL_FILENAME}.gpg"
TMP="${TARGET}.tmp.$$"
trap 'rm -f "${TMP}"' EXIT

# Encrypt to a temporary file
gpg --batch --yes \
    --recipient-file "${ENCRYPTION_KEY_FILE}" \
    --output "${TMP}" \
    --encrypt "${SOURCE_PATH}"

# Envelope check: non-empty and a public-key encrypted message
[ -s "${TMP}" ] || { logger -t wal-archive "ERROR: empty output for ${WAL_FILENAME}"; exit 1; }
gpg --batch --list-packets "${TMP}" 2>/dev/null | grep -q ':public key encrypted data:' \
  || { logger -t wal-archive "ERROR: ${WAL_FILENAME} is not a public-key encrypted file"; exit 1; }

mv -f "${TMP}" "${TARGET}"
trap - EXIT

logger -t wal-archive "Archived WAL segment: ${WAL_FILENAME}"

```

**Implementation — nightly full backup script:**

```bash
#!/bin/bash
# /usr/local/bin/nightly-backup.sh
# Executed by cron at 22:00 UTC (01:00 Asia/Riyadh)

set -euo pipefail

TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
BACKUP_DIR="${BACKUP_STORAGE_PATH}/full"
BACKUP_FILE="${BACKUP_DIR}/basebackup_${TIMESTAMP}"
ENCRYPTION_KEY_FILE="${BACKUP_ENCRYPTION_KEY_PATH}"
RETENTION_DAYS=30

echo "=== Starting nightly backup: ${TIMESTAMP} ==="

# 1. Full PostgreSQL base backup.
#    With --format=tar, pg_basebackup writes a DIRECTORY at ${BACKUP_FILE}
#    containing base.tar.gz (and pg_wal.tar.gz) — there is no single
#    ${BACKUP_FILE}.tar.gz. PostgreSQL 15 compresses with --compress=gzip:6;
#    --gzip does not exist and bare --compress=6 is the pre-15 syntax.
pg_basebackup \
  --host="${DB_HOST}" \
  --port="${DB_PORT}" \
  --username="${DB_BACKUP_USER}" \
  --pgdata="${BACKUP_FILE}" \
  --format=tar \
  --compress=gzip:6 \
  --checkpoint=fast \
  --progress \
  --verbose \
  --write-recovery-conf

# 2. Pack the backup directory into a single archive, then encrypt it.
#    Asymmetric: this host holds only the PUBLIC key. Decryptability is
#    proven from the restore host (monthly drill), not here.
tar -czf "${BACKUP_FILE}.tar.gz" -C "${BACKUP_DIR}" "$(basename "${BACKUP_FILE}")"

gpg --batch --yes \
    --recipient-file "${ENCRYPTION_KEY_FILE}" \
    --output "${BACKUP_FILE}.tar.gz.gpg" \
    --encrypt "${BACKUP_FILE}.tar.gz"

# 3. Verify the encrypted envelope is well formed
gpg --batch --list-packets "${BACKUP_FILE}.tar.gz.gpg" 2>/dev/null | \
  grep -q ':public key encrypted data:'
echo "Backup envelope verification: OK"

# 4. Record backup metadata
cat > "${BACKUP_FILE}.meta.json" << EOF
{
  "timestamp": "${TIMESTAMP}",
  "type": "full_base_backup",
  "pg_version": "$(pg_basebackup --version)",
  "size_bytes": $(stat -f%z "${BACKUP_FILE}.tar.gz.gpg" 2>/dev/null || stat -c%s "${BACKUP_FILE}.tar.gz.gpg"),
  "checksum": "$(sha256sum "${BACKUP_FILE}.tar.gz.gpg" | cut -d' ' -f1)",
  "encrypted": true,
  "wal_position": "$(psql -h ${DB_HOST} -U ${DB_BACKUP_USER} -t -c 'SELECT pg_current_wal_lsn()')"
}
EOF

# 5. Clean up unencrypted backup
rm -f "${BACKUP_FILE}.tar.gz"

# 6. Remove backups older than retention period
find "${BACKUP_DIR}" -name "basebackup_*.gpg" -mtime +${RETENTION_DAYS} -delete
find "${BACKUP_DIR}" -name "basebackup_*.meta.json" -mtime +${RETENTION_DAYS} -delete

# 7. Document evidence backup (incremental)
echo "=== Starting document backup ==="
rsync -az --delete \
  "${DOCUMENT_STORAGE_PATH}/" \
  "${BACKUP_DIR}/documents_${TIMESTAMP}/"

echo "=== Nightly backup complete: ${TIMESTAMP} ==="
```

**Implementation — backup monitoring (worker integration):**

```typescript
// src/modules/audit/backup-monitor.service.ts
const BACKUP_MONITOR_LOCK_ID = 100006;

@Injectable()
export class BackupMonitorService {
  // Check backup freshness daily at 07:00 Asia/Riyadh (04:00 UTC)
  // — runs AFTER the nightly backup should have completed
  @Cron('0 4 * * *')
  async checkBackupFreshness() {
    const acquired = await this.tryLock(BACKUP_MONITOR_LOCK_ID);
    if (!acquired) return;

    try {
      const health = await this.getBackupHealth();

      // Alert conditions
      if (!health.lastFullBackup || health.fullBackupAgeHours > 26) {
        await this.createAlert('BACKUP_STALE',
          `Last full backup is ${health.fullBackupAgeHours?.toFixed(1) ?? 'unknown'} hours old ` +
          `(threshold: 26 hours). RPO may be at risk.`
        );
      }

      if (!health.walArchivingActive) {
        await this.createAlert('WAL_ARCHIVE_INACTIVE',
          'WAL archiving appears inactive — point-in-time recovery is unavailable. ' +
          'RPO is degraded to last full backup.'
        );
      }

      if (health.backupStorageUsedPct > 80) {
        await this.createAlert('BACKUP_STORAGE_HIGH',
          `Backup storage is ${health.backupStorageUsedPct}% full. ` +
          `Verify retention cleanup is running.`
        );
      }
    } finally {
      await this.releaseLock(BACKUP_MONITOR_LOCK_ID);
    }
  }

  async getBackupHealth(): Promise<BackupHealth> {
    return {
      lastFullBackup:       await this.getLastFullBackupTime(),
      fullBackupAgeHours:   await this.getFullBackupAgeHours(),
      walArchivingActive:   await this.isWalArchivingActive(),
      lastWalSegment:       await this.getLastArchivedWalSegment(),
      walLagBytes:          await this.getWalArchiveLag(),
      backupStorageUsedPct: await this.getStorageUsagePercent(),
      lastRestoreTest:      await this.getLastRestoreTestDate(),
      restoreTestPassed:    await this.getLastRestoreTestResult(),
    };
  }

  private async isWalArchivingActive(): Promise<boolean> {
    const result = await this.prisma.$queryRaw`
      SELECT last_archived_time,
             (now() - last_archived_time) AS lag
      FROM pg_stat_archiver
    `;
    const row = (result as any[])[0];
    if (!row?.last_archived_time) return false;
    // WAL should archive at least every 5 minutes (archive_timeout)
    const lagMinutes = row.lag?.minutes ?? 999;
    return lagMinutes < 10;
  }
}
```

**Implementation — environment configuration:**

```env
# .env.production — Backup section
BACKUP_STORAGE_PATH=/mnt/backup/nurseapp           # encrypted backup storage mount
BACKUP_ENCRYPTION_KEY_PATH=/etc/nurseapp/backup.pub # GPG PUBLIC key — backup host only
BACKUP_GPG_HOME=/etc/nurseapp/gpg-restore           # dedicated keyring holding the PRIVATE key — restore host only, NEVER on production
DB_BACKUP_USER=nurseapp_backup                      # dedicated read-only backup user
DOCUMENT_STORAGE_PATH=/var/lib/nurseapp/documents   # document evidence directory
BACKUP_RETENTION_DAYS=30                            # full backup retention
WAL_RETENTION_DAYS=7                                # WAL segment retention
```

**Restore procedure — step-by-step:**

The following procedure restores the system to a specific point in time. It must be rehearsed monthly on the staging environment.

```bash
#!/bin/bash
# /usr/local/bin/restore-database.sh
# Point-in-time recovery to a specified timestamp
# Usage: ./restore-database.sh "2026-09-15 14:30:00+03"

set -euo pipefail

TARGET_TIME="$1"  # Asia/Riyadh timestamp to recover to
RESTORE_DIR="/var/lib/postgresql/restore"
BACKUP_DIR="${BACKUP_STORAGE_PATH}/full"
WAL_DIR="${BACKUP_STORAGE_PATH}/wal"
# Dedicated GPG keyring holding the PRIVATE key. It exists on the restore
# host only and is never present on the production database server.
GPG_HOME="${BACKUP_GPG_HOME}"

echo "=== AIGH NurseApp Database Restore ==="
echo "Target recovery time: ${TARGET_TIME}"
echo ""

# Step 1: Stop application services
echo "Step 1: Stopping application services..."
docker compose -f docker-compose.production.yml stop api worker

# Step 2: Find the most recent full backup BEFORE the target time
echo "Step 2: Locating base backup..."
BACKUP_FILE=$(find "${BACKUP_DIR}" -name "basebackup_*.gpg" -print | sort | \
  while read f; do
    ts=$(basename "$f" | sed 's/basebackup_//;s/.tar.gz.gpg//')
    if [[ "${ts}" < "$(date -d "${TARGET_TIME}" -u +%Y%m%d_%H%M%S)" ]]; then
      echo "$f"
    fi
  done | tail -1)

if [[ -z "${BACKUP_FILE}" ]]; then
  echo "ERROR: No base backup found before target time ${TARGET_TIME}"
  exit 1
fi
echo "Using base backup: $(basename ${BACKUP_FILE})"

# Step 3: Decrypt and extract the base backup
echo "Step 3: Decrypting and extracting base backup..."
mkdir -p "${RESTORE_DIR}"
# Asymmetric decryption with the private key from the restore-host keyring.
# (A passphrase file cannot decrypt a public-key encrypted message.)
gpg --batch --homedir "${GPG_HOME}" \
    --decrypt "${BACKUP_FILE}" | \
  tar -xzf - -C "${RESTORE_DIR}"

# Step 4: Configure point-in-time recovery
echo "Step 4: Configuring PITR..."
cat > "${RESTORE_DIR}/recovery.signal" << EOF
# Point-in-time recovery target
EOF

# restore_command must exit non-zero WITHOUT creating %p when a segment is
# not yet archived; `gpg --decrypt > %p` leaves a zero-length WAL file and
# aborts recovery. The wrapper below handles that case.
cat >> "${RESTORE_DIR}/postgresql.auto.conf" << EOF
# PITR configuration
restore_command = '/usr/local/bin/wal-restore.sh ${WAL_DIR} ${GPG_HOME} %f %p'
recovery_target_time = '${TARGET_TIME}'
recovery_target_action = 'promote'
EOF

# Step 5: Start PostgreSQL with recovery configuration
echo "Step 5: Starting PostgreSQL in recovery mode..."
pg_ctl -D "${RESTORE_DIR}" start -w

# Step 6: Wait for recovery to complete
echo "Step 6: Waiting for recovery to reach target time..."
until psql -h localhost -U "${DB_BACKUP_USER}" -c "SELECT pg_is_in_recovery()" | grep -q 'f'; do
  sleep 5
  echo "  Recovery in progress..."
done

echo "Recovery complete — database is at target time: ${TARGET_TIME}"

# Step 7: Verify data integrity
echo "Step 7: Running integrity checks..."
psql -h localhost -U "${DB_BACKUP_USER}" -d nurseapp << 'SQL'
  -- Verify core tables are populated
  SELECT 'employees' AS tbl, count(*) FROM employees
  UNION ALL
  SELECT 'contracts', count(*) FROM contracts
  UNION ALL
  SELECT 'credentials', count(*) FROM credentials
  UNION ALL
  SELECT 'audit_entries', count(*) FROM audit_entries;

  -- Verify audit chain integrity (last 100 entries)
  SELECT count(*) AS broken_chain_links
  FROM (
    SELECT previous_hash,
           lag(hash) OVER (ORDER BY id) AS prev_row_hash
    FROM audit_entries
    ORDER BY id DESC
    LIMIT 100
  ) ae
  WHERE ae.previous_hash IS DISTINCT FROM ae.prev_row_hash;

  -- Verify no data beyond the recovery target time
  SELECT max(created_at) AS latest_record FROM audit_entries;
SQL

# Step 8: Restart application services
echo "Step 8: Restarting application services..."
docker compose -f docker-compose.production.yml start api worker

echo ""
echo "=== Restore complete ==="
echo "IMPORTANT: Verify application behavior and notify operations team."
echo "Run the post-restore checklist (Section 10.6)."
```

**Implementation — WAL restore helper (restore host only):**

```bash
#!/bin/bash
# /usr/local/bin/wal-restore.sh <wal_dir> <gpg_home> <wal_filename> <destination>
# Called by PostgreSQL's restore_command. Must return non-zero when the segment
# is not yet archived, and must never leave a partial destination file.

set -euo pipefail

WAL_DIR="$1"
GPG_HOME="$2"
WAL_FILENAME="$3"
DEST="$4"

SRC="${WAL_DIR}/${WAL_FILENAME}.gpg"
[ -f "${SRC}" ] || exit 1                     # not archived yet — PostgreSQL retries

TMP="${DEST}.tmp.$$"
if gpg --batch --homedir "${GPG_HOME}" --decrypt --output "${TMP}" "${SRC}" 2>/dev/null \
   && [ -s "${TMP}" ]; then
  mv -f "${TMP}" "${DEST}"
else
  rm -f "${TMP}"
  exit 1
fi
```

**Post-restore verification checklist:**

| Step | Verification | Pass criteria |
| :--- | :--- | :--- |
| 1 | Login with a known account | Authentication succeeds; correct role and scope |
| 2 | Check employee count | Matches expected count for the recovery point |
| 3 | Verify audit chain | No broken hash-chain links in the last 100 events |
| 4 | Check latest audit timestamp | No events after the recovery target time |
| 5 | Verify credential status | Spot-check 5 credentials — expiry dates and validity match expectations |
| 6 | Verify contract coverage | Spot-check 5 active contracts — dates and status are correct |
| 7 | Check notification queue | Pending notifications exist; SMTP worker resumes delivery |
| 8 | Verify document evidence | Download 3 document versions — files are intact and checksums match |
| 9 | Run eligibility check | Check eligibility for 3 nurses — result matches expected status |
| 10 | Check SCFHS sync log | Last sync timestamp is before recovery point; no future entries |

**Monthly restore drill procedure:**

1. Select a random point in time from the past 7 days.
2. Execute the restore procedure on the staging environment.
3. Run the full post-restore verification checklist.
4. Record the drill results: restore time (must be < 4 hours RTO), data completeness (must be < 15 minutes RPO) and any issues encountered.
5. File the drill record in the operations log. The drill date is tracked by the backup monitor (Section 10.6 health endpoint).

**Backup security rules:**

- Backup encryption keys are stored separately from the backups themselves. The decryption key is never present on the production database server — it exists only on the designated restore host.
- The backup database user (`nurseapp_backup`) has `SELECT` and `pg_read_all_data` privileges only — it cannot modify data or schema.
- Backup storage is access-controlled to operations personnel only. Application service accounts cannot read or write to backup storage.
- Immediately after creation, every backup is verified on the backup host as a **well-formed encrypted envelope** (non-empty, public-key encrypted). Decryptability is proven from the restore host during the monthly drill — the private key is deliberately absent from the production database server.
- `archive_command` and `restore_command` both publish files atomically (write to a temporary path, then move), so an interrupted run can never leave a partial file that PostgreSQL would treat as valid.
- Backup logs do not contain database content, credentials or document data — only timestamps, sizes, checksums and status.

**Acceptance criteria for backup and disaster recovery:**

| Criterion | Required evidence |
| :--- | :--- |
| Automated full backup | Nightly `pg_basebackup` completes, is encrypted and passes verification |
| WAL archiving | Continuous WAL shipping with < 10 minute lag; `pg_stat_archiver` confirms active archiving |
| Point-in-time recovery | Restore to a specific minute within the last 7 days produces a consistent database |
| RPO compliance | Recovery from the latest WAL shows data loss ≤ 5 minutes with `archive_timeout = 300` — inside the 15-minute requirement |

**RPO derivation (2.8.7 clarification):** the achievable RPO is `archive_timeout` plus WAL shipping delay, not the sub-minute figure quoted in earlier revisions. A target below 5 minutes requires lowering `archive_timeout` (for example to 60 seconds) and re-measuring under representative load; the acceptance evidence must state which timeout was in force.
| RTO compliance | Full restore procedure completes in < 4 hours on staging hardware |
| Document backup | Document evidence directory is synced nightly; restored documents match checksums |
| Backup monitoring | Stale backup (> 26 hours), inactive WAL archiving and storage capacity alerts fire correctly |
| Encryption | Backups are encrypted at rest; decryption uses a dedicated restore-host keyring holding the private key, which is absent from the production database server; each monthly drill proves decryptability end-to-end |
| Script correctness | `pg_basebackup` completes with `--format=tar --compress=gzip:6`; the packed archive is encrypted (no reference to a non-existent path); `restore_command` returns non-zero without creating an empty WAL file when a segment is missing |
| Monthly drill | At least one successful restore drill is documented for the current month |
| Retention cleanup | Backups older than 30 days and WAL segments older than 7 days are automatically removed |

### 10.7 Database privilege separation

**Specification:** The system enforces least-privilege access to PostgreSQL by splitting the current single database identity into four purpose-built roles. The runtime application can read and write business data but cannot alter schema, rewrite audit history or access backup infrastructure. Schema changes require a separate migration identity that is never used at runtime.

**Role architecture:**

```mermaid
flowchart TB
    subgraph "PostgreSQL Role Hierarchy"
        OWNER["nurseapp_owner (superuser-granted)"]
        MIG["nurseapp_migration"]
        RT["nurseapp_runtime"]
        BK["nurseapp_backup"]
        AR["nurseapp_audit_reader"]
    end

    OWNER -->|"GRANT USAGE ON SCHEMA"| MIG
    OWNER -->|"GRANT USAGE ON SCHEMA"| RT
    OWNER -->|"GRANT USAGE ON SCHEMA"| BK
    OWNER -->|"GRANT USAGE ON SCHEMA"| AR

    MIG -->|"Used by"| PRISMA["Prisma Migrate CLI"]
    RT -->|"Used by"| API["NestJS API + Worker"]
    BK -->|"Used by"| PGDUMP["pg_basebackup / pg_dump"]
    AR -->|"Used by"| AUDIT["Audit export / compliance queries"]
```

**Role definitions and privilege grants:**

| Role | Purpose | Grants | Explicitly denied |
| :--- | :--- | :--- | :--- |
| `nurseapp_owner` | Database owner; used only for initial provisioning | All privileges on database and schemas | Never used at runtime or by application code |
| `nurseapp_migration` | Schema changes via Prisma Migrate | `CREATE`, `ALTER`, `DROP` on all tables, indexes, sequences, types; `SELECT`, `INSERT`, `UPDATE`, `DELETE` on `_prisma_migrations`; `USAGE` on all schemas | No runtime data access beyond the migration journal |
| `nurseapp_runtime` | NestJS API and background worker | `SELECT`, `INSERT`, `UPDATE`, `DELETE` on all business tables; `USAGE`, `SELECT` on all sequences; `EXECUTE` on application functions | No `CREATE`, `ALTER`, `DROP`, `TRUNCATE`; no `DELETE` on `audit_entries`; no direct `INSERT` on `employees` (onboarding via `fn_onboard_employee_with_contract` only); contract writes constrained by `trg_contract_status_guard` |
| `nurseapp_backup` | `pg_basebackup` and WAL archiving | `pg_read_all_data` (PostgreSQL 14+ built-in); `REPLICATION` attribute | No write access; no schema modification |
| `nurseapp_audit_reader` | Compliance and audit export queries | `SELECT` on `audit_entries`, `audit_batches`, `audit_snapshots`; `SELECT` on `scfhs_verification_log`, `grace_period_log`, `push_delivery_log`, `idempotency_keys` | No access to business tables; no write access |

**Implementation — role creation script:**

```sql
-- 01_create_roles.sql
-- Run once by nurseapp_owner during initial provisioning

-- 1. Migration role — owns schema changes
CREATE ROLE nurseapp_migration WITH LOGIN PASSWORD :'MIGRATION_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- 2. Runtime role — application data access only
CREATE ROLE nurseapp_runtime WITH LOGIN PASSWORD :'RUNTIME_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- 3. Backup role — read-only with replication
CREATE ROLE nurseapp_backup WITH LOGIN PASSWORD :'BACKUP_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE REPLICATION;

-- 4. Audit reader — read-only on audit tables
CREATE ROLE nurseapp_audit_reader WITH LOGIN PASSWORD :'AUDIT_READER_PASSWORD'
  NOSUPERUSER NOCREATEDB NOCREATEROLE;

-- Grant schema usage to all roles
GRANT USAGE ON SCHEMA public TO nurseapp_migration, nurseapp_runtime,
  nurseapp_backup, nurseapp_audit_reader;
```

**Implementation — privilege grant script:**

```sql
-- 02_grant_privileges.sql
-- Run after every migration to re-apply grants on new objects
-- Executed by nurseapp_owner or as a post-migration hook

-- ============================================================
-- nurseapp_migration: schema modification + migration journal
-- ============================================================
GRANT CREATE ON SCHEMA public TO nurseapp_migration;

-- Migration role needs to read/write the Prisma migration journal
GRANT SELECT, INSERT, UPDATE, DELETE ON _prisma_migrations
  TO nurseapp_migration;

-- Allow migration role to create/alter/drop any table structure
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO nurseapp_migration;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO nurseapp_migration;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO nurseapp_migration;

-- ============================================================
-- nurseapp_runtime: business data CRUD, no DDL, no audit DELETE
-- ============================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public
  TO nurseapp_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public
  TO nurseapp_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public
  TO nurseapp_runtime;

-- Revoke dangerous privileges from runtime
REVOKE CREATE ON SCHEMA public FROM nurseapp_runtime;
REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM nurseapp_runtime;

-- Protect audit trail: runtime can INSERT but not DELETE or UPDATE
-- (hash-chained audit entries are append-only by design)
REVOKE DELETE, UPDATE ON audit_entries FROM nurseapp_runtime;

-- ============================================================
-- Onboarding lockdown (bulletproof contract-first)
-- ============================================================
-- Revoke direct INSERT rights on employees only. Employee creation must go
-- through fn_onboard_employee_with_contract, which creates the employee and
-- its first approved contract atomically.
REVOKE INSERT ON employees FROM nurseapp_runtime;

-- Contracts remain writable: HR must create draft contracts, renew them and
-- terminate them (Section 4). The contract-first guarantee comes from the
-- employees restriction plus the FK and the status trigger below — not from
-- banning contract inserts, which would break renewal.
GRANT EXECUTE ON FUNCTION fn_onboard_employee_with_contract TO nurseapp_runtime;

-- Guard every contract insert/update: valid initial status and sane dates.
CREATE OR REPLACE FUNCTION fn_contract_status_guard() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status NOT IN ('Draft', 'PendingApproval', 'Approved', 'Active',
                        'Expired', 'Suspended', 'Terminated', 'Superseded') THEN
    RAISE EXCEPTION 'Invalid contract status %', NEW.status;
  END IF;
  IF NEW.end_date < NEW.start_date THEN
    RAISE EXCEPTION 'Contract end date precedes start date';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
   SET search_path = pg_catalog, public;

CREATE TRIGGER trg_contract_status_guard
  BEFORE INSERT OR UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION fn_contract_status_guard();

-- Apply same grants for future tables created by migration role
ALTER DEFAULT PRIVILEGES FOR ROLE nurseapp_migration IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nurseapp_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nurseapp_migration IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nurseapp_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE nurseapp_migration IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO nurseapp_runtime;

-- ============================================================
-- nurseapp_backup: read-only data access for pg_basebackup
-- ============================================================
GRANT pg_read_all_data TO nurseapp_backup;

-- ============================================================
-- nurseapp_audit_reader: read-only on audit and log tables
-- ============================================================
GRANT SELECT ON audit_entries, audit_batches, audit_snapshots
  TO nurseapp_audit_reader;
GRANT SELECT ON scfhs_verification_log, grace_period_log,
  push_delivery_log, idempotency_keys TO nurseapp_audit_reader;
```

**Implementation — post-migration hook:**

After each `prisma migrate deploy`, the privilege grant script must run to apply grants to any newly created tables. Add a post-migration step to the deployment pipeline:

```bash
#!/bin/bash
# post-migrate-grants.sh
# Run as nurseapp_owner after prisma migrate deploy

set -euo pipefail

echo "=== Applying privilege grants after migration ==="

psql -h "${DB_HOST}" -p "${DB_PORT}" -U nurseapp_owner -d nurseapp \
  -f /app/sql/02_grant_privileges.sql

echo "=== Verifying runtime role restrictions ==="

# Verify runtime cannot ALTER or DROP tables
RESULT=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U nurseapp_runtime -d nurseapp \
  -c "ALTER TABLE audit_entries ADD COLUMN test_col TEXT;" 2>&1 || true)

if echo "$RESULT" | grep -q "permission denied"; then
  echo "PASS: Runtime role cannot alter schema"
else
  echo "FAIL: Runtime role has unexpected DDL privileges"
  exit 1
fi

# Verify runtime cannot DELETE audit entries
RESULT=$(psql -h "${DB_HOST}" -p "${DB_PORT}" -U nurseapp_runtime -d nurseapp \
  -c "DELETE FROM audit_entries WHERE 1=0;" 2>&1 || true)

if echo "$RESULT" | grep -q "permission denied"; then
  echo "PASS: Runtime role cannot delete audit entries"
else
  echo "FAIL: Runtime role can delete audit entries"
  exit 1
fi

echo "=== All privilege checks passed ==="
```

**Connection string configuration:**

```bash
# .env — each identity uses a dedicated connection string
# Runtime (NestJS API + Worker)
DATABASE_URL="postgresql://nurseapp_runtime:${RUNTIME_PASSWORD}@${DB_HOST}:5432/nurseapp?schema=public"

# Migration (Prisma Migrate CLI — CI/CD pipeline only)
MIGRATION_DATABASE_URL="postgresql://nurseapp_migration:${MIGRATION_PASSWORD}@${DB_HOST}:5432/nurseapp?schema=public"

# Backup (pg_basebackup — backup scripts only)
DB_BACKUP_USER="nurseapp_backup"
DB_BACKUP_PASSWORD="${BACKUP_PASSWORD}"

# Audit reader (compliance export — audit tooling only)
AUDIT_DATABASE_URL="postgresql://nurseapp_audit_reader:${AUDIT_READER_PASSWORD}@${DB_HOST}:5432/nurseapp?schema=public"
```

**Prisma configuration for dual connection strings:**

```typescript
// prisma/schema.prisma — use separate URLs for runtime vs. migration
datasource db {
  provider          = "postgresql"
  url               = env("DATABASE_URL")         // nurseapp_runtime
  directUrl         = env("MIGRATION_DATABASE_URL") // nurseapp_migration (used by prisma migrate)
}
```

**Rules:**

1. The `nurseapp_runtime` identity is the only one used by application code at startup. Environment configuration must never contain the migration or owner credentials.
2. The `nurseapp_migration` identity is available only to the CI/CD pipeline during `prisma migrate deploy`. It is never passed to running application instances.
3. Audit entries (`audit_entries`, `audit_batches`, `audit_snapshots`) are append-only at the runtime level: the runtime role can `INSERT` but cannot `UPDATE` or `DELETE`.
4. The `nurseapp_backup` identity uses PostgreSQL's `pg_read_all_data` role (requires PostgreSQL 14+) and the `REPLICATION` attribute for streaming WAL.
5. The `nurseapp_audit_reader` identity can only read audit and compliance log tables — it cannot access business data (nurses, contracts, credentials) or write anything.
6. After every migration, the post-migration grant script runs automatically to ensure new tables receive the correct grants and restrictions.
7. Password rotation for each role follows the hospital's credential rotation policy. Each role's password is stored in a separate secret (e.g. separate Vault paths or environment variables) so that rotating one does not require redeploying unrelated components.

**Acceptance criteria for database privilege separation:**

| Criterion | Required evidence |
| :--- | :--- |
| Runtime DDL denied | `nurseapp_runtime` cannot `CREATE TABLE`, `ALTER TABLE`, or `DROP TABLE`; verified by attempted DDL that returns "permission denied" |
| Audit immutability | `nurseapp_runtime` can `INSERT` into `audit_entries` but `DELETE` and `UPDATE` return "permission denied" |
| Migration restricted | `nurseapp_migration` credentials exist only in the release pipeline and are never present on application hosts; it holds DDL rights while the grant scripts run as `nurseapp_owner`. **Note:** DDL rights on business tables imply read access — the control is credential custody and pipeline scope, not SQL-level read isolation |
| Backup read-only | `nurseapp_backup` can `SELECT` from all tables and stream WAL but cannot `INSERT`, `UPDATE`, or `DELETE` |
| Audit reader scoped | `nurseapp_audit_reader` can read audit/log tables but cannot access `nurses`, `contracts`, `credentials`, or other business tables |
| Post-migration grants | New tables created by a migration are automatically granted to `nurseapp_runtime` and restricted appropriately |
| No credential leakage | Application runtime environment contains only the runtime connection string; migration and owner credentials are absent |
| Password independence | Each role uses a separate password stored in a separate secret; rotating one does not affect other roles |

**Migration-specific temporary role:** To support the legacy migration bridge (Section 10.10), a temporary role `nurseapp_migration_admin` is created 48 hours before go-live. This role bypasses the `REVOKE INSERT` restrictions on `employees` and `contracts` for the duration of the cutover. The role is deleted immediately after `commitValidatedData()` completes. Every action taken by this role is logged in a separate `migration_audit_log`.

### 10.8 Deep observability & business health

**Specification:** The system implements a "Business Health" framework to detect silent failures in background logic. This ensures that the Materialized Eligibility State and external syncs are accurate and timely.

1. **The Consistency Auditor (anti-drift)** — a background worker randomly samples 1% of the workforce daily. It runs the heavy `check_nurse_eligibility` function and compares the result against the `employee_eligibility_state` table. If a mismatch is found, it:
   - Logs a `consistency_audit_log` entry.
   - Immediately triggers a `refreshState()` for that employee.
   - Updates the `eligibility_drift_rate` metric.

2. **Vital sign monitoring** — the system monitors "SLA-based" metrics rather than hardware metrics:
   - Sync freshness: time since the last successful SCFHS verification for the total workforce.
   - PAM-audit gap: number of privileged sessions active without a corresponding audit event.
   - Storage integrity: percentage of evidence files that passed the weekly SHA-256 checksum verification.

3. **Business health API** — the system exposes a `/api/v1/system/health/business` endpoint for the Hospital IT dashboard. It returns a JSON report of all `system_health_metrics` and the latest consistency audit results.

**Implementation — consistency auditor & health service:**

```typescript
// src/modules/observability/consistency-auditor.worker.ts
@Injectable()
export class ConsistencyAuditorWorker {
  @Cron('0 3 * * *') // Daily at 03:00
  async auditEligibilityState() {
    const employees = await this.prisma.employee.findMany({
      where: { deletedAt: null },
      select: { id: true }
    });

    // Sample 1% of workforce
    const sample = employees.filter(() => Math.random() < 0.01);

    for (const emp of sample) {
      const actual = await this.prisma.employeeEligibilityState.findUnique({
        where: { employee_id: emp.id }
      });
      const expected = await this.eligibilityEngine.calculate(emp.id, new Date());

      // A missing state row is itself a drift condition — never dereference it.
      if (!actual) {
        await this.prisma.consistencyAuditLog.create({
          data: {
            employee_id: emp.id,
            expected_status: expected.eligibilityType,
            actual_status: null,
            drift_detected: true,
          }
        });
        await this.eligibilityStateService.refreshState(emp.id, 'CONSISTENCY_AUDIT_MISSING_STATE');
        continue;
      }

      if (actual.status !== expected.eligibilityType) {
        // Drift Detected!
        await this.prisma.consistencyAuditLog.create({
          data: {
            employee_id: emp.id,
            expected_status: expected.eligibilityType,
            actual_status: actual.status,
            drift_detected: true,
          }
        });
        // Immediate Correction
        await this.eligibilityStateService.refreshState(emp.id, 'CONSISTENCY_AUDIT');
      }
    }
  }
}

// src/modules/observability/business-health.service.ts
@Injectable()
export class BusinessHealthService {
  async getLogicHealthReport() {
    const metrics = await this.prisma.systemHealthMetrics.findMany();
    const drifts = await this.prisma.consistencyAuditLog.count({
      where: { drift_detected: true, created_at: { gte: subDays(new Date(), 7) } }
    });

    return {
      overall_status: metrics.some(m => m.status === 'CRITICAL') ? 'CRITICAL' : 'HEALTHY',
      vitals: metrics,
      weekly_drift_count: drifts,
      timestamp: new Date(),
    };
  }
}
```

### 10.9 Operational survivability: shadow mode

**Specification:** To prevent "Big-Bang" failures where a logic update accidentally marks hundreds of nurses as ineligible, the system uses Shadow Mode Deployment.

**The workflow:**

- **Parallel execution** — when a new version of the eligibility logic is deployed, it is set to `SHADOW` status.
- **The comparison** — every time the `EligibilityStateService` calculates a status, it runs:
  - `result_active = eligibilityEngine.calculate(empId)`
  - `result_candidate = eligibilityEngineCandidate.calculate(empId)`
- **Discrepancy logging** — if `result_active !== result_candidate`, the event is logged in `eligibility_shadow_log`.
- **Promotion criteria** — the new logic is only promoted to `ACTIVE` status after 7 days of operation with zero discrepancies, or after an HR Admin reviews and approves the specific discrepancies.

**Implementation — shadow logic:**

```typescript
// src/modules/eligibility/shadow-mode.service.ts
async calculateWithShadow(employeeId: number) {
  const active = await this.activeEngine.calculate(employeeId);
  const candidate = await this.candidateEngine.calculate(employeeId);

  if (active.status !== candidate.status) {
    await this.prisma.eligibilityShadowLog.create({
      data: {
        employee_id: employeeId,
        active_status: active.status,
        candidate_status: candidate.status,
        discrepancy: true,
        logic_version: 'v2.9_candidate'
      }
    });
  }
  return active; // Always return production logic to the user
}
```

### 10.10 Legacy migration bridge

**Specification:** To prevent the "Day Zero" crash caused by dirty legacy data, the system uses a three-stage migration bridge. Data is never imported directly into production tables; it must pass through the scrubbing pipeline.

**The scrubbing pipeline:**

- **Stage 1 — Import (Ingestion):** Legacy CSV/Excel files are loaded into the `migration_staging` schema. No constraints are applied at this stage to ensure 100% of the legacy data is captured.
- **Stage 2 — Scrubbers (Validation):** A set of automated cleaners runs against the staging data:
  - **Contract Resolver** — scans `raw_contracts` for overlapping dates or gaps. Any overlap is flagged as `BLOCK` in the `migration_validation_errors` table.
  - **Position Mapper** — maps legacy titles (e.g., "Staff Nurse Grade 1") to the `position_directory` codes via a lookup table. Unmapped titles are flagged as `WARN`.
  - **Evidence Hasher** — scans the provided legacy file paths, calculates the SHA-256 checksum, and verifies the file exists. Missing files are flagged as `BLOCK`.
- **Stage 3 — Commit (Production Push):** Once the `migration_validation_errors` table contains zero `BLOCK` entries, the system executes a final `INSERT INTO ... SELECT` to move the cleaned data into the production `employees`, `contracts`, and `credentials` tables.

**Implementation — the commit function:**

```typescript
// src/modules/migration/migration.service.ts
async commitValidatedData() {
  return this.prisma.$transaction(async (tx) => {
    // Verify no BLOCK errors remain
    const blockCount = await tx.$queryRaw`
      SELECT count(*) FROM migration_validation_errors
      WHERE severity = 'BLOCK' AND resolved = false
    `;
    if (blockCount[0].count > 0) {
      throw new Error('Cannot commit: unresolved BLOCK errors remain');
    }

    // Move validated employees from staging to production
    await tx.$executeRaw`
      INSERT INTO employees (name, job_number, unit_id, position, contact_email)
      SELECT raw_name, raw_job_num, map_unit(raw_unit), map_pos(raw_position), raw_email
      FROM migration_staging.raw_employees
      WHERE import_status = 'VALIDATED'
    `;

    // Move validated contracts
    await tx.$executeRaw`
      INSERT INTO contracts (employee_id, start_date, end_date, status)
      SELECT e.id, r.start_date::date, r.end_date::date, 'Approved'
      FROM migration_staging.raw_contracts r
      JOIN employees e ON e.job_number = r.emp_job_num
      WHERE r.import_status = 'VALIDATED'
    `;
  });
}
```

**Migration-specific role (temporary):** To support the cutover, a temporary role `nurseapp_migration_admin` is created:

- **Purpose** — this role has the power to bypass `REVOKE INSERT` restrictions on `employees` and `contracts` for a limited window during the migration.
- **Lifecycle** — the role is created 48 hours before go-live and is deleted immediately after the `commitValidatedData()` process completes.
- **Audit** — every action taken by the `nurseapp_migration_admin` is logged in a separate `migration_audit_log` to ensure no unauthorized data was injected during the cutover.

**Acceptance criteria for legacy migration bridge:**

| Criterion | Required evidence |
| :--- | :--- |
| Dirty data detection | Import a dataset with overlapping contracts and missing files; verify that `migration_validation_errors` correctly identifies all BLOCK issues |
| Commit guard | Verify that `commitValidatedData` refuses to run if a single BLOCK error remains |
| Post-commit cleanup | After the commit, the `migration_staging` schema is wiped and the `nurseapp_migration_admin` role is deleted |
| Production integrity | Imported data in production maintains full integrity — no ghost employees, no overlapping contracts, all FK constraints pass |
| Role lifecycle | Verify the migration role exists only during the 48-hour cutover window and is absent before and after |

---

## 11. Verification and acceptance

### 11.1 Baseline test results (v0.2.1)

The following tests were executed locally against the NurseApp v0.2.1 baseline:

**Backend verification:**

- TypeScript type checks and production builds passed (both backend and frontend).
- Backend lint check passed.
- **61 unit tests passed** — covering service behavior and simulated SMTP success, retry and missing configuration.
- **16 PostgreSQL workflow tests passed** — covering atomic onboarding, duplicate rollback, draft registration denial, future renewal preservation, contract overlap rejection, record scoping, required credentials, assignment/publication, pending evidence preservation, renewal rejection, revocation, concurrent account claiming, notification deduplication/ownership, private-field/draft visibility and audit failure rollback.

**HTTP verification:** Login, workforce/contract/analytics/profile endpoints, staff configuration denial, refresh rotation and replay rejection.

**Migration verification:** Fresh production migrations, first-administrator bootstrap, repeat migration run, demo-chain migrations and checksum validation.

**Known issues:**

- Two pre-existing unit tests were skipped in the original v0.2.1 baseline. Both were resolved in the reviewed package — see Section 0.3.
- The frontend build reports a large-bundle advisory — code-splitting is needed before large rollout.
- Original baseline tests ran on Node 24 / PostgreSQL 17.11. The reviewed package validation (Section 0.3) confirmed 68 unit tests + 20 PostgreSQL workflow tests + 4 browser-client tests + 24 HTTP checks passing on the same versions. Production targets Node 20 / PostgreSQL 15 — those environments must run their own checks.

### 11.2 Hospital configuration and acceptance

The following must be completed before operational deployment:

1. Hospital approval and configuration of mandatory credentials (including credential rules for new positions per Section 3.1.1), units/positions, staffing targets and role scopes.
2. Public HTTPS address, SMTP credentials and real mailbox acceptance; notification failure monitoring.
3. Browser-driven HR/supervisor/employee pilot, including documents and all intended devices.
4. Staging verification of production containers and PostgreSQL version, backup restoration and migration of a representative existing dataset.
5. Load/performance checks, audit retention and operational monitoring.

### 11.3 Acceptance criteria for each subsystem

Each subsystem must demonstrate its own implementation evidence before it is considered delivered:

| Subsystem | Required acceptance evidence |
| :--- | :--- |
| Credential catalog CRUD | 5 categories and 16 templates seeded with field definitions; category/template/requirement CRUD via API with referential safety; template field definitions stored as JSONB enabling custom fields; credential requirements trigger eligibility revalidation on add/delete; evidence upload via Image/PDF with quarantine pipeline; tracking_data JSONB on credentials stores per-template field values; SCFHS classification ranks captured; audit trail for all mutations |
| Hospital organizational structure | 5 departments and the active unit configuration with valid hierarchy and bed counts within 0–500 (seeded baseline: 47 units / 582 beds — editable in-system at any time); department/unit/bed CRUD plus bulk capacity update and CSV import with referential safety; soft deletes exclude from active views but preserve history; single and bulk capacity changes logged with actor and reason; coverage monitoring reads the current `bed_count`; frontend selectors grouped by department |
| Position directory | Directory seeded with all 16 positions; legacy codes migrated (zero AHN/CI employees); FK on employees.position and credential_requirements.position enforced; full CRUD (create/read/update/delete) via API with referential safety guards; is_active validation rejects deactivated codes for new assignments; schedulability toggle triggers assignment revalidation; soft delete blocked when employees or credential rules reference the code; audit events for all mutations |
| Module boundaries | Lint rule blocks cross-module repository imports; all tests pass after each module extraction |
| Separate worker | API instances do not start schedulers; competing workers lease work safely; interrupted jobs recover |
| Request audit logging | Interceptor captures all requests; redaction prevents sensitive field leakage; X-Request-Id traces work end-to-end |
| Browser session hardening | Cookie and CSRF controls pass; revoked sessions are denied |
| SMTP delivery | Real hospital relay delivers emails; retry/recovery behavior verified per Section 7.3 checklist |
| Request idempotency | Duplicate onboarding/invitation/publication requests with same key return original result; concurrent duplicates receive 409 while the lease is live; a key whose lease lapsed is retaken rather than blocked; missing key returns 400; expired keys and lapsed leases are cleaned up; stored replay payloads contain identifiers only, never full response bodies |
| SSO / MFA | Identity linking preserves local role and scope rules (when implemented) |
| Upload quarantine and scanning | Uploaded files enter `PENDING` status; ClamAV scan transitions to `CLEAN` or `INFECTED`; only `CLEAN` files are downloadable; infected files are deleted; EICAR test file detected; content-type spoofing rejected; retry logic exhausts after 3 attempts; current approved evidence remains available |
| Object storage | Authorization and checksums pass; failed transfers reconcile; restore retains matching versions |
| Database privilege separation | Runtime cannot `ALTER`/`DROP` tables, cannot `DELETE` audit entries, and cannot directly `INSERT` into `employees`; contract rows are accepted only through the status/date trigger; HR can still create, renew and terminate contracts; migration role is confined to the release pipeline; backup role is read-only with replication; post-migration grants apply to new tables automatically |
| Bulletproof onboarding | Direct `INSERT INTO employees` via API returns Postgres Permission Denied; successful onboarding creates exactly one employee and one approved contract in a single transaction; failed contract creation leaves zero rows in `employees` |
| PII searchability | Searching for an Iqama number returns the correct record in < 100ms; database query logs show searches hitting `iqama_blind_index`, not `employees.name` or `tracking_data`; direct search for plaintext Iqama in the encrypted column returns zero results |
| Audit immutability vs erasure | Deleting a user's key from `user_encryption_keys` makes their PII in `audit_entries` unreadable; the `audit_entries` hash chain remains valid (no broken links) after a crypto-shredding event; a "Right to Erasure" request does not require deleting any rows from the audit table |
| Materialized eligibility | Roster "Available Nurses" query returns results in < 50ms regardless of rule complexity; updating a credential status immediately reflects in `employee_eligibility_state`; daily cron refreshes all states without blocking the API; roster publication re-validates candidates against the canonical engine inside the publication transaction, while the state table serves pool and dashboard reads |
| SCFHS resilience | Simulated 100+ rapid requests do not trigger IP blocking (rate-limiter works); simulated API 500 errors trip the circuit breaker for 15 minutes; simulated outage keeps nurses eligible for 48 hours under STALE status; a single failed job does not stop other verification jobs in the queue |
| Monitoring and recovery | Failure alerts reach operators; backup restoration and recovery targets demonstrated |
| SCFHS credential verification | mTLS connectivity verified; nightly sync runs without errors; auto-suspend triggers on REVOKED status; discrepancy notifications reach HR; fallback to manual verification when SCFHS is unreachable |
| Configurable grace periods | Grace activates on expiry with renewal in progress; eligibility returns ELIGIBLE_WITH_GRACE; grace expiry demotes assignments; renewal approval closes grace; no stacking across cycles; audit trail complete |
| Redis circuit breaker | Redis outage triggers automatic database fallback; no 500 errors during Redis downtime; sensitive operations always use fresh DB queries; circuit recovers automatically on Redis restart |
| Backup and disaster recovery | Nightly encrypted backups; continuous WAL archiving; point-in-time restore to any minute within 7 days; RPO < 15 minutes; RTO < 4 hours; monthly drill documented |
| Mobile push notifications | Device token registration and deregistration work; push delivery via FCM and hospital gateway; failed tokens are deactivated; delivery log records all attempts; fallback to dashboard + SMTP when push fails |
| Frontend code-splitting | Route chunks load on demand; vendor chunks separated (react, antd, utils incl. react-query); preloading on hover eliminates visible loading; initial bundle < 200 KB gzipped; `scripts/check-bundle-size.mjs` fails CI when the entry exceeds 200 KB gz or any chunk exceeds 150 KB gz (entry currently **Unmet** at 266.47 KB) |
| Deployment and scale | Production-version compatibility, representative load and required failover behavior verified |
| Secure evidence vault | Direct access to storage URL returns 403 Forbidden; valid signed URL works for 30s then returns 403 Forbidden; uploading a file stores a SHA-256 hash and modifying the file on disk triggers a "Tampering Alert" during the integrity scan; manual deletion of a DB record results in the file being removed from storage during the next cleanup cycle |
| Admin guardrails | Attempting to promote a user to Admin without a second signature returns PENDING_APPROVAL; attempting to approve one's own high-impact request returns 403 Forbidden; admin access is revoked immediately upon `privileged_sessions.expires_at`; every elevation request and approval is recorded in `audit_entries` with initiator and approver IDs |
| Business observability | Inducing a "state drift" (manually change a value in `employee_eligibility_state` via SQL) is detected and corrected by the `ConsistencyAuditorWorker` within 24 hours; the `/health/business` endpoint returns CRITICAL when SCFHS sync fails for > 48 hours; `system_health_metrics` are updated automatically by background workers |
| Operational survival | Root login triggers "Siren" alert and creates a non-deletable audit entry; shadow mode detects a simulated logic discrepancy and logs it without affecting the active roster; `/api/v1` remains functional after `/api/v2` is deployed; break-glass session is automatically revoked after 4 hours |
| FHIR interoperability | Calling the FHIR endpoint returns a valid JSON resource that passes the official HL7 FHIR Validator; external HIS can retrieve a practitioner's role via the FHIR adapter |
| Attendance integration | Simulating a missing "Clock In" for a published shift triggers a coverage alert to the supervisor within 15 minutes; clock-in events are successfully persisted from the external feed |
| Data portability | The "Exit Package" contains all employee records, contract history, and all evidence files; the exported JSON is validated against a vendor-neutral schema |
| Legacy migration bridge | 1. Import a "dirty" dataset (overlapping contracts, missing files) and verify that `migration_validation_errors` correctly identifies all BLOCK issues. 2. Verify that `commitValidatedData` refuses to run if a single BLOCK error remains. 3. Prove that after the commit, the `migration_staging` schema is wiped and the `nurseapp_migration_admin` role is deleted. 4. Verify that imported data in production maintains full integrity (no ghost employees, no overlapping contracts) |
| Policy transitions | 1. Set a requirement to TRANSITION mode; verify that nurses without the credential remain eligible but receive a "Policy Warning" alert. 2. Set `transition_deadline` to yesterday; verify that nurses are now immediately marked INELIGIBLE |
| Emergency waivers | 1. Create a waiver for an ineligible nurse; verify that their status changes to ELIGIBLE immediately. 2. Verify that the waiver expires automatically at the `expiry_date` timestamp, reverting the nurse to INELIGIBLE. 3. Verify that waiver creation triggers a high-priority audit entry |
| Operational resilience (chaos) | 1. Redis failure: kill Redis during peak load; verify system falls back to PostgreSQL without returning 500 errors. 2. API latency: simulate 10s latency on SCFHS API; verify circuit breaker trips and system remains responsive. 3. Database lock: induce a row lock on the eligibility table; verify API returns a controlled "System Busy" message rather than timing out. 4. Storage outage: simulate evidence vault failure; verify "Maintenance Mode" alert is displayed for downloads while the rest of the app remains functional |

**End-to-end hospital pilot must include:** HR onboarding → employee account claiming → credential upload (with quarantine scan) → credential approval (with SCFHS verification) → supervisor publication (including grace-period scenario) → staff visibility (with grace indicator) → push notification delivery → notification acknowledgement → renewal rejection that preserves current approved evidence → SCFHS nightly sync with discrepancy detection → grace expiry triggering assignment demotion.

### 11.4 Node 20 / PostgreSQL 15 validation runbook

**Context:** All 116 reviewed-package tests (68 unit + 20 PostgreSQL workflow + 4 browser-client + 24 HTTP checks) were executed on Node 24 / PostgreSQL 17.11. The production target is Node 20 LTS / PostgreSQL 15. Behavioral differences between these versions could cause silent failures in production that the test suite would catch if run on the correct versions.

**Runtime target alignment:** The system is validated on a high-version baseline but must be deployed on the production target.

| Environment | Node version | PostgreSQL version | Purpose |
| :--- | :--- | :--- | :--- |
| Validation baseline | Node 24.x | PostgreSQL 17.11 | Local dev / CI fast-track |
| Production target | Node 20 LTS | PostgreSQL 15 | Hospital production |

**Known risk areas between Node 24 → Node 20:**

| Area | Risk | What to watch for |
| :--- | :--- | :--- |
| `fetch` API | Node 20 ships `fetch` as experimental (behind `--experimental-fetch` in early 20.x, stable from 20.0 but with fewer features) | Any test or code using `fetch` without `node-fetch` or `axios`; check `undici` version differences |
| `crypto` module | Subtle API additions in Node 22+ (e.g. `crypto.hash()`) | Any direct `crypto` calls beyond standard `createHash`/`createHmac` |
| `fs/promises` | Stable in both, but `fs.cp` recursive copy was experimental until Node 20.5 | Any recursive copy operations in tests or setup scripts |
| ECMAScript features | `Array.groupBy`, `Set` methods, `Promise.withResolvers` added post-Node 20 | Tests using newer built-in methods without polyfills |
| `import.meta.resolve` | Behavior differs between Node 20 and 24 | Module resolution in dynamic imports |
| npm version | Node 20 ships npm 9–10; Node 24 ships npm 11 | `package-lock.json` format changes; peer dependency resolution |

**Known risk areas between PostgreSQL 17.11 → 15:**

| Area | Risk | What to watch for |
| :--- | :--- | :--- |
| `MERGE` statement | Full `MERGE` support added in PostgreSQL 15; PostgreSQL 17 has extended syntax | Any `MERGE` statements in raw SQL or Prisma `$executeRaw` |
| JSON functions | `JSON_TABLE`, `JSON_QUERY`, `JSON_VALUE` added in PostgreSQL 16+ | Raw SQL using SQL/JSON path functions beyond `jsonb_path_query` |
| Identity columns | `GENERATED ALWAYS AS IDENTITY` behavior is consistent, but `OVERRIDING SYSTEM VALUE` rules tightened in PG 16 | Seeded test data using explicit identity values |
| `pg_stat_*` views | Column additions in PG 16–18 | Monitoring queries or backup validation referencing new stat columns |
| `GRANT pg_read_all_data` | Available from PG 14+ (safe) | Database privilege separation (Section 10.7) relies on this — verified compatible |
| Collation / ICU | PG 15 defaults to libc collation; PG 16+ offers ICU by default | Text ordering in `ORDER BY` on name fields — may produce different sort for accented characters |
| `NULLS NOT DISTINCT` | Added in PG 15 — available in both | Unique constraints with nullable columns — verify behavior matches |

**Validation procedure — step by step:**

**Step 1 — Provision the target environment:**

```bash
# Use Docker for an isolated, reproducible environment
# PostgreSQL 15
docker run -d --name nurseapp-pg15 \
  -e POSTGRES_USER=nurseapp_owner \
  -e POSTGRES_PASSWORD=test_password \
  -e POSTGRES_DB=nurseapp \
  -p 5415:5432 \
  postgres:15-alpine

# Node 20 — use nvm or a Docker container
nvm install 20
nvm use 20
node --version  # must report v20.x.x
npm --version   # record for reproducibility
```

**Step 2 — Install dependencies and verify build:**

```bash
# Clean install to avoid node_modules compiled for Node 24
rm -rf node_modules package-lock.json
npm install

# Backend build — watch for TypeScript errors or deprecated API warnings
npm run build:backend 2>&1 | tee build-backend-node20.log

# Frontend build — watch for Vite warnings (separate from code-splitting work)
npm run build:frontend 2>&1 | tee build-frontend-node20.log

# Lint check
npm run lint 2>&1 | tee lint-node20.log
```

**Step 3 — Run database migrations against PostgreSQL 15:**

```bash
# Point Prisma at the PG 15 instance
export DATABASE_URL="postgresql://nurseapp_owner:test_password@localhost:5415/nurseapp"

# Run migrations
npx prisma migrate deploy 2>&1 | tee migrate-pg15.log

# Verify schema matches expected state
npx prisma db pull --print 2>&1 | tee schema-pg15.log

# Run demo/seed data if applicable
npm run seed 2>&1 | tee seed-pg15.log
```

**Step 4 — Execute the full test suite:**

```bash
# Unit tests (68 expected)
npm run test:unit 2>&1 | tee unit-tests-node20-pg15.log

# PostgreSQL workflow tests (20 expected)
npm run test:pg 2>&1 | tee pg-tests-node20-pg15.log

# HTTP endpoint tests
npm run test:http 2>&1 | tee http-tests-node20-pg15.log

# Record results
echo "=== Test Summary ===" >> validation-summary.log
echo "Node version: $(node --version)" >> validation-summary.log
echo "npm version: $(npm --version)" >> validation-summary.log
echo "PostgreSQL version: $(psql -h localhost -p 5415 -U nurseapp_owner -d nurseapp -t -c 'SELECT version();')" >> validation-summary.log
grep -E "Tests:|passed|failed|skipped" unit-tests-node20-pg15.log >> validation-summary.log
grep -E "Tests:|passed|failed|skipped" pg-tests-node20-pg15.log >> validation-summary.log
```

**Step 5 — Compare results against baseline.** Every `_Fill after run_` cell must be replaced with the observed value before the report is signed; an unfilled cell means the step was not executed:

| Check | Baseline (Node 24 / PostgreSQL 17.11) | Target (Node 20 LTS / PostgreSQL 15) | Status |
| :--- | :--- | :--- | :--- |
| TypeScript build | Passed | _Fill after run_ | |
| Frontend build | Passed (with bundle warning) | _Fill after run_ | |
| Lint | Passed | _Fill after run_ | |
| Unit tests | 68 passed, 0 skipped | _Fill after run_ | |
| PG workflow tests | 20 passed | _Fill after run_ | |
| HTTP tests | Passed | _Fill after run_ | |
| Migrations | Passed | _Fill after run_ | |

**Step 6 — Investigate any failures:**

For each failing test, classify the root cause:

| Classification | Action | Example |
| :--- | :--- | :--- |
| Node API difference | Add a polyfill or use a compatible API; document the change | `Array.groupBy` → use lodash `groupBy` |
| PostgreSQL syntax difference | Rewrite raw SQL to PG 15-compatible syntax | `MERGE` → `INSERT ... ON CONFLICT` |
| Behavioral difference | Determine which behavior is correct for production; adjust test or code | Collation sort order |
| Timing / race condition | Exposed by different performance characteristics; fix the underlying race | Test depends on execution order |
| Genuine bug masked by newer version | Fix the bug — this is the whole point of the validation | Error handling path not taken on PG 18 |

**Step 7 — Document and sign off:**

```markdown
## Node 20 / PostgreSQL 15 Validation Report

- **Date:** ____
- **Validated by:** ____
- **Node version:** 20.x.x
- **PostgreSQL version:** 15.x
- **Total tests:** __ passed / __ failed / __ skipped
- **Failures fixed:** (list each with PR reference)
- **Remaining skipped tests:** (reference Section 11.5)
- **Build warnings:** (reference Section 2.8 for code-splitting)
- **Conclusion:** PASS / FAIL — ready for staging deployment: YES / NO
```

**Acceptance criteria for Node 20 / PostgreSQL 15 validation:**

| Criterion | Required evidence |
| :--- | :--- |
| Clean build | Backend and frontend build with zero errors on Node 20 |
| All unit tests pass | 68+ unit tests pass (0 skipped — previously skipped tests resolved per Section 0.3) |
| All PG workflow tests pass | 20 PostgreSQL workflow tests pass on PostgreSQL 15 |
| All HTTP tests pass | HTTP endpoint tests pass |
| Migration compatibility | `prisma migrate deploy` runs cleanly on a fresh PostgreSQL 15 database |
| No new skipped tests | No additional tests are skipped compared to the baseline |
| Validation report signed | Completed report with version numbers, test counts and sign-off |

### 11.5 Skipped unit test investigation and resolution

**Context:** The v0.2.1 baseline has two pre-existing skipped unit tests. These were noted during the initial audit but their purpose and skip reason were not documented. Skipped tests may hide edge cases, deferred bug fixes, or incomplete features that become relevant as the system hardens.

**Investigation procedure:**

**Step 1 — Locate the skipped tests:**

```bash
# Find all skipped/pending/todo test markers in the codebase
grep -rn "\.skip\|xit(\|xdescribe(\|it\.todo\|test\.skip\|pending(" \
  src/ test/ --include="*.spec.ts" --include="*.test.ts" \
  | tee skipped-tests-inventory.log

# Count and list
echo "=== Skipped test inventory ==="
cat skipped-tests-inventory.log | wc -l
cat skipped-tests-inventory.log
```

**Step 2 — Classify each skipped test:**

For each skipped test, determine its classification:

| Classification | Description | Action |
| :--- | :--- | :--- |
| Deferred edge case | Test covers a valid scenario that was not yet implemented | Implement the feature or behavior; unskip the test |
| Flaky / environment-dependent | Test fails intermittently or depends on external state | Fix the flakiness (mock external dependencies, eliminate race conditions); unskip |
| Placeholder for future work | Test was written as a reminder for planned functionality | If the functionality is now specified (check Sections 2–10), implement and unskip; if not yet planned, document and keep skipped with a clear `// TODO:` comment referencing the relevant roadmap item |
| Obsolete | Test covers behavior that was intentionally changed or removed | Delete the test with a comment in the commit explaining why |
| Bug workaround | Test was skipped because it exposes a known bug | Fix the bug; unskip the test; add a regression guard |

**Step 3 — Resolve or document each test:**

For each skipped test, fill in this resolution record:

```markdown
### Skipped Test #1

- **File:** ____
- **Test name:** ____
- **Skip marker:** `.skip` / `xit` / `test.todo` / other
- **Classification:** ____
- **Root cause:** ____
- **Resolution:** (one of the following)
  - [ ] Implemented missing behavior and unskipped
  - [ ] Fixed flakiness and unskipped
  - [ ] Deleted as obsolete (commit: ____)
  - [ ] Kept skipped — reason: ____ (link to roadmap item)
- **PR / commit reference:** ____

### Skipped Test #2

- **File:** ____
- **Test name:** ____
- **Skip marker:** `.skip` / `xit` / `test.todo` / other
- **Classification:** ____
- **Root cause:** ____
- **Resolution:**
  - [ ] Implemented missing behavior and unskipped
  - [ ] Fixed flakiness and unskipped
  - [ ] Deleted as obsolete (commit: ____)
  - [ ] Kept skipped — reason: ____ (link to roadmap item)
- **PR / commit reference:** ____
```

**Step 4 — Prevent future untracked skips:**

Add a CI guard that fails the build if the number of skipped tests increases without an accompanying `// SKIP-REASON:` comment:

```typescript
// jest.config.ts — custom reporter to track skipped tests
// Alternatively, add a CI step:
// jest --json | jq '.numPendingTests' → fail if > ALLOWED_SKIPS

export default {
  // ... existing config
  reporters: [
    'default',
    ['./test/reporters/skip-guard.ts', {
      maxAllowedSkips: 0,  // target: zero skipped tests after resolution
      requireSkipReason: true,
    }],
  ],
};
```

```typescript
// test/reporters/skip-guard.ts
import type { Reporter, TestResult } from '@jest/reporters';

class SkipGuardReporter implements Reporter {
  private maxAllowed: number;

  constructor(_config: any, options: { maxAllowedSkips: number }) {
    this.maxAllowed = options.maxAllowedSkips ?? 0;
  }

  onRunComplete(_contexts: Set<any>, results: { numPendingTests: number }) {
    if (results.numPendingTests > this.maxAllowed) {
      console.error(
        `\n❌ SKIP GUARD: ${results.numPendingTests} skipped test(s) found ` +
        `(maximum allowed: ${this.maxAllowed}). ` +
        `Resolve skipped tests or update maxAllowedSkips with justification.\n`,
      );
      process.exitCode = 1;
    }
  }
}

export default SkipGuardReporter;
```

**Rules:**

1. Every skipped test must have a documented reason. The `// SKIP-REASON:` comment must reference either a roadmap section or a ticket.
2. The target is zero skipped tests. If a test must remain skipped, the skip count is recorded in `jest.config.ts` and any increase requires a justification in the PR description.
3. Skipped tests are reviewed during each Phase gate (Section 13.1). Tests that remain skipped for more than one phase must be re-evaluated: implement, delete, or promote to a roadmap item.

**Acceptance criteria for skipped test resolution:**

| Criterion | Required evidence |
| :--- | :--- |
| Inventory complete | All skipped tests in the codebase are listed with file path and test name |
| Each test classified | Every skipped test has a classification and documented root cause |
| Resolution applied | Each test is either unskipped (with the fix), deleted (with justification), or retained with a `SKIP-REASON` comment |
| Skip guard active | CI reporter fails the build if skipped test count exceeds the configured maximum |
| No new skips | The resolved state has equal or fewer skipped tests than the baseline (2) |

---

## 12. Implementation status

| Capability | Status | Implementation reference |
| :--- | :--- | :--- |
| React / NestJS / PostgreSQL / Redis stack | Implemented | Section 2.1 |
| Position directory and constraints | Implementation specification (FK fix applied) | Section 3.1.1 |
| Hospital organizational structure (departments, units, bed capacity) | Implementation specification | Section 2.9 |
| Unit & bed capacity bulk configuration (bulk API, CSV import, configuration grid) | Implementation specification | Section 2.9 |
| Credential catalog CRUD (categories, templates, field definitions, requirements) | Implementation specification | Section 5.1 |
| Contract-first onboarding | Bulletproof / DB-enforced | Sections 3.1–3.2, V36 |
| Login and session management | Implemented | Section 3.3 |
| Browser session hardening (HttpOnly cookie + Origin/custom-header CSRF defense) | Implemented in reviewed package; HTTPS browser acceptance pending | Sections 0.2, 3.4 |
| Contract lifecycle with overlap prevention | Implemented | Section 4 |
| Credential verification and renewal | Implemented | Section 5.2 |
| Canonical eligibility engine | Implemented | Section 6.1 |
| Assignment, publication and coverage | Implemented | Section 6.2–6.3 |
| Notification scan and dashboard | Implemented | Section 7.1 |
| SMTP delivery | Implemented; hospital SMTP staging verification pending | Sections 0.1, 7.2–7.4 |
| Role-based access and scoping | Implemented | Section 8 |
| Domain-level audit (hash-chained) | Implemented | Section 9.1 |
| Request-level audit logging | Partially implemented; denied/failed request coverage remains | Sections 0.1, 9.2 |
| Module boundary formalization | Implementation specification | Sections 2.3–2.7 |
| Separate background worker | Implemented in reviewed production composition; container acceptance pending | Sections 0.2, 10.2–10.3 |
| Worker leases (replaces session-scoped advisory locks) | Implementation specification | Sections 10.3, 10.1 (V49) |
| Upload quarantine and scanning | Implementation specification | Section 5.3.2 |
| SSO / MFA | Planned | Section 3.5 |
| Object storage migration | Planned | Section 5.3.1 |
| SCFHS credential verification integration | Implementation specification | Section 5.4 |
| Configurable eligibility grace periods | Implementation specification | Section 6.1.1 |
| Mobile push notifications | Implementation specification | Section 7.6 |
| Authorization database fallback | Implemented conservatively: authoritative authorization reads PostgreSQL and denies on database failure | Sections 0.2, 9.3 |
| Redis circuit breaker with auto-recovery | Implementation specification | Section 9.3.1 |
| Request idempotency keys | Implemented for onboarding, invitation creation and roster publication | Sections 0.2, 9.5 |
| Backup and disaster recovery | Implementation specification | Section 10.6 |
| Database privilege separation | Implementation specification (onboarding lockdown scoped to `employees`; contract writes trigger-guarded) | Section 10.7 |
| PDPL compliance & encryption | Implementation specification | Section 8.3 |
| Data residency controls | Implementation specification | Section 8.3.6 |
| PII blind indexing (searchability) | Implementation specification | Sections 8.3, 10.1 (V37) |
| Crypto-shredding (erasure vs audit) | Implementation specification | Sections 8.3, 9.1 (V38) |
| Materialized eligibility state | Implementation specification | Sections 6.1, 10.1 (V39) |
| SCFHS resilience & sync state | Implementation specification | Sections 5.4, 10.1 (V40) |
| Migration slot resolution | Resolved | Section 10.1 |
| Frontend code-splitting | Partially implemented; route chunks exist but shared entry remains 266.47 KB gzipped | Sections 0.2, 2.8 |
| Node 24 / PostgreSQL validation | Node 24 + PostgreSQL 17 local validation passed; PostgreSQL 15 container CI still required | Sections 0.3, 11.4 |
| Skipped unit test resolution | Resolved in the database-enabled run: 68 passed, 0 skipped | Sections 0.3, 11.5 |
| CI/CD pipeline | Implemented; remote execution and release approval evidence pending | Sections 0.1, 10.4 |
| High availability | Planned | Section 10.5 |
| Secure evidence vault & integrity | Implementation specification | Sections 5.3, 10.1 (V41) |
| Admin guardrails (PAM & four-eyes) | Implementation specification | Sections 3.5, 8.1 (V42) |
| Deep observability & business health | Implementation specification | Sections 10.8, 10.1 (V43) |
| Operational survivability (break-glass/shadow) | Implementation specification | Sections 3.6, 10.9 (V44) |
| Enterprise integration (FHIR/attendance/export) | Implementation specification | Sections 14.1–14.3 (V45) |
| Legacy migration bridge (staging/scrubbing) | Implementation specification | Section 10.10 (V47) |
| Policy transitions & emergency waivers | Implementation specification | Section 6.1.2 (V48) |
| Frontend globalized experience (i18n) | Implementation specification | Section 2.10 |
| Blue/green deployment strategy | Planned (target architecture) | Section 10.4 |

Thirty-nine sections have complete implementation specifications with code patterns, schemas and step-by-step instructions (Sections 2.3–2.10, 3.1, 3.1.1, 3.4, 3.5, 3.6, 5.1, 5.3, 5.3.2, 5.4, 6.1, 6.1.1, 6.1.2, 7.2–7.4, 7.6, 8.1, 8.3, 9.2, 9.3.1, 9.5, 10.2–10.3, 10.6, 10.7, 10.8, 10.9, 10.10, 14.1–14.3). Two execution tasks have detailed validation runbooks (Sections 11.4–11.5). Three urgent decision action plans have cascade analysis, stakeholder assignments and deadlines (Section 13.4). All implementation specifications remain unimplemented until the corresponding acceptance evidence in Section 11.3 exists.

---

## 13. Roadmap and outstanding decisions

### 13.1 Four-phase roadmap

**Phase 1 — Validate and harden (Weeks 1–3; revised after source review)**

1. Run the full 116-test suite on Node 20 / PostgreSQL 15 in CI or staging. Local Node 24 / PostgreSQL 17 validation has passed.
2. Complete HTTPS browser acceptance for the implemented session hardening described in Sections 0.2 and 3.4.
3. Implement request-level audit logging per Section 9.2.
4. Validate current database-authoritative authorization under Redis outage and production load; do not cache authorization grants without versioned invalidation.
5. Validate the implemented request idempotency behavior in staging, including concurrent submission, uncertain retries and 24-hour expiry.
6. **Implement database privilege separation** per Section 10.7 — create `nurseapp_runtime`, `nurseapp_migration`, `nurseapp_backup` and `nurseapp_audit_reader` roles with least-privilege grants, including the `REVOKE INSERT` lockdown on `employees`/`contracts`; verify runtime cannot alter schema, delete audit entries, or directly insert onboarding records.
7. **Set up automated PostgreSQL backups with WAL archiving and tested restore procedure** per Section 10.6 — configure nightly full backups, continuous WAL streaming, encrypted storage and monthly restore drill.
8. Keep the database-enabled authorization tests active in CI; they passed in the reviewed local run.
9. Continue frontend bundle optimization. Route lazy loading is implemented, but the shared entry still exceeds the performance target.
10. **Deploy upload quarantine and scanning** per Section 5.3.2 — ClamAV integration, quarantine pipeline, content-type verification; no unscanned file downloadable.
11. **Deploy PDPL technical controls** per Section 8.3 — field-level encryption (AES-256-GCM), blind indexing, log redaction, and the residency startup check.
12. **Validate bulletproof onboarding in staging** via negative test cases — direct `INSERT INTO employees` must return Permission Denied, and failed contract creation must leave zero rows.

Gate: All 116+ tests pass on production-target versions; security items verified in staging; first backup restore drill succeeds within 4-hour RTO.

**Phase 2 — Staging and hospital configuration (Weeks 3–6)**

1. Provision staging environment matching production topology.
2. **Apply position directory migration** per Section 3.1.1 — run pre-migration audit, migrate legacy codes (AHN → ACTING_HEAD, CI → NURSE_EDUCATOR), apply foreign key constraint, verify revalidation. **Apply hospital organizational structure migration** per Section 2.9 — seed departments and nursing units with bed capacity from Hospital Master Unit Directory, apply foreign keys on employees/credential_requirements/shift_assignments, verify referential integrity. Configure hospital-specific mandatory credentials for new positions (PRACTITIONER, NS, DON, DEPUTY_DON, ADMIN), units and staffing targets.
3. **Configure grace periods per credential template** per Section 6.1.1 — work with hospital policy to determine appropriate grace windows for each credential type (SCFHS license, life support certifications, identity documents).
4. Verify SMTP delivery end-to-end per the Section 7.3 checklist.
5. **Implement mobile push notifications** per Section 7.6 — device token registration, FCM and hospital gateway adapters, multi-channel delivery (dashboard + SMTP + push).
6. Validate the separate background worker composition in staging per Sections 10.2–10.3 (implemented in reviewed package — Section 0.2).
7. Begin formalizing module boundaries per Sections 2.3–2.8 (start with audit and workforce).
8. Deploy TLS-terminated reverse proxy; verify HTTPS-only access.
9. Add structured logging, request IDs and basic health-check monitoring.
10. Run browser-driven pilot: HR onboarding → employee claim → credential upload (with quarantine scan) → supervisor publish (including grace-period scenario) → staff view → push notification delivery.

Gate: End-to-end hospital workflow completes on staging with real SMTP, real credential policies and grace period behavior verified.

**Phase 3 — Controlled pilot (Weeks 6–10)**

1. Deploy to production for one unit (e.g. NICU) with a limited user group.
2. Monitor API latency (p95 target: <500 ms), worker heartbeat and failed audits.
3. **Integrate SCFHS credential verification** per Section 5.4 — establish mTLS connectivity with SCFHS staging, validate against 10+ practitioner records, enable nightly sync for pilot unit.
4. Verify backup restore within 4-hour RTO on representative data.
5. Conduct load test simulating peak concurrent scheduling window.
6. Collect user feedback on workflows, mobile experience, notification timing and grace-period visibility.
7. Assess document storage volume — decide PostgreSQL BLOBs vs. object storage.
8. Complete module boundary formalization (remaining modules).
9. **Validate grace period behavior in production** — confirm that credentials expiring during the pilot activate grace windows correctly and that renewed credentials close the grace cycle.

Gate: Pilot unit operates for 2+ weeks with no critical incidents; SCFHS sync running nightly; recovery drill succeeds.

**Phase 4 — Scale and extend (Weeks 10+)**

1. Roll out to additional units (ED, OR) based on pilot learnings.
2. Implement SSO integration if hospital identity provider is available.
3. Add MFA for HR Admin and System Admin accounts.
4. Migrate document storage to private object storage per Section 5.3.1 if volume warrants.
5. Introduce redundant application instances if uptime requirements demand it.

Gate: Multi-unit operation stable; performance targets met under measured load.

### 13.2 Remaining gaps — priority order

| Priority | Gap | Why it matters | Depends on |
| :--- | :--- | :--- | :--- |
| 1 | Credential rule configuration for new positions | CRUD endpoints for credential requirements now specified (Section 5.1.4). PRACTITIONER, NS, DON, DEPUTY_DON, and ADMIN still require HR to define mandatory rules via the new API before employees can be onboarded with those codes. The eligibility engine blocks scheduling when no rules exist for a unit/position | Hospital credential policy decision |
| 2 | Node 20 / PostgreSQL 15 test validation | Validation runbook complete (Section 11.4); all 116 tests ran on Node 24 / PostgreSQL 17.11; production behavior on Node 20 / PostgreSQL 15 unknown | Nothing — start immediately |
| 3 | PDPL technical controls | Field encryption, blind indexing, log redaction and residency check (Section 8.3) are required for SDAIA legal compliance | Hosting decision |
| 4 | Database privilege separation | Implementation specification complete (Section 10.7); runtime can currently alter schema and rewrite audit history | Hosting decision |
| 5 | Upload quarantine and malware scanning | Implementation specification complete (Section 5.3.2); unscanned documents can currently be approved | Hosting decision; ClamAV deployment |
| 6 | Automated backup and recovery drill | Implementation specification complete (Section 10.6); needs hosting decision to deploy | Hosting decision |
| 7 | Frontend bundle optimization | Implementation specification complete (Section 2.8); large-bundle warning; slow loads on hospital workstations | Nothing — can start anytime |
| 8 | Mobile push notifications | Implementation specification complete (Section 7.6); staff currently have no mobile alerts | FCM project or hospital push gateway |
| 9 | SSO / MFA for privileged accounts | Password-only auth for admin accounts | Hospital identity provider decision |
| 10 | Object storage migration | PostgreSQL BLOBs acceptable for pilot only | Measured document volume |
| 11 | Multi-instance high availability | Single application host is a failure point | Availability requirements decision |
| 12 | ~~Two skipped unit tests~~ | Resolved in the reviewed package — 68 passed, 0 skipped (Section 0.3). Investigation checklist in Section 11.5 remains available for future skip prevention | Resolved |
| 13 | Admin guardrails (PAM & four-eyes) | High-impact admin actions currently lack dual-authorization and just-in-time elevation (Sections 3.5, 8.1) | Hosting decision |
| 14 | Enterprise integration (FHIR/attendance) | No standardized FHIR exchange or real-time attendance feed yet (Sections 14.1–14.2) | Hospital HIS/PACS integration agreement |
| 15 | Data portability & vendor neutrality | No standardized exit package for procurement compliance (Section 14.3) | Nothing — can start anytime |
| 16 | Legacy migration bridge | No data migration plan from hospital's current workforce process (Section 10.10) | Hospital legacy data source identification |
| 17 | Frontend globalized experience (i18n) | No Arabic/RTL support; no bilingual notifications (Section 2.10) | Translation file completion |
| 18 | Policy transitions & emergency waivers | No phased credential rollout or emergency waiver mechanism (Section 6.1.2) | Hospital credential policy decision |

### 13.3 Decisions required before production sizing

| Decision | Required input |
| :--- | :--- |
| Hosting and scope | Hospital-approved location; single or multi-hospital deployment |
| Capacity | Employee count, peak concurrent users, scheduling peaks, document volume, retention |
| Identity | Local accounts or hospital identity provider; MFA and account-linking rules |
| Operational continuity | Accepted downtime, recovery point, recovery time; redundancy requirements |
| Hospital policy | Mandatory credentials, expiry exceptions, unit staffing targets, field visibility |
| Position credential policy | Mandatory credential rules for new positions (PRACTITIONER, NS, DON, DEPUTY_DON, ADMIN); advanced practice credential scope for PRACTITIONER; teaching certification requirements for NURSE_EDUCATOR |
| Grace period policy | Per-template grace windows; which credentials allow grace; whether auto-suspend on SCFHS revocation is acceptable |
| SCFHS integration | API access agreement with SCFHS; mTLS certificate provisioning; acceptable sync frequency; auto-suspend policy for adverse SCFHS results |
| Push notification gateway | Firebase Cloud Messaging project or hospital-provided push gateway; notification opt-in policy; which notification types warrant push delivery |
| Malware scanning infrastructure | ClamAV daemon hosting; signature update frequency; quarantine storage location separate from clean evidence |
| Operations ownership | Owners of backups, audit retention, email failures, certificate/secret rotation, SCFHS certificate renewal, ClamAV signature updates, release approval |

### 13.4 Urgent decision action plans and deadlines

This section expands the three highest-impact hospital decisions from Section 13.2 into concrete action plans with stakeholder assignments, deliverables and deadlines. Each decision blocks multiple subsystems; the combined timeline impact analysis at the end shows how delays cascade through the four-phase roadmap.

#### 13.4.1 U1 — Hosting decision (CRITICAL PATH)

**Deadline:** Week 1 of Phase 1. Every week of delay shifts the entire roadmap by one week.

**Why this is the critical path:** This single decision unblocks eight subsystems. No other decision has a wider blast radius. Until the hospital approves a hosting location, none of the following can move past specification:

| Blocked subsystem | Section | Migration | Why it is blocked |
| :--- | :--- | :--- | :--- |
| PDPL field encryption (AES-256-GCM) | 8.3 | V35 | Master key storage strategy depends on hosting (HSM, KMS, or file-based vault) |
| Database privilege separation | 10.7 | — | Role creation (`nurseapp_runtime`, `nurseapp_migration`, `nurseapp_backup`, `nurseapp_audit_reader`) requires knowing the PostgreSQL deployment model |
| Automated backup + WAL archiving | 10.6 | — | Encrypted backup destination, retention policy and WAL shipping target depend on infrastructure |
| Upload quarantine + ClamAV | 5.3.2 | V32 | ClamAV daemon needs a host, signature update schedule and quarantine storage separate from clean evidence |
| Admin guardrails (PAM + four-eyes) | 3.5, 8.1 | V42 | Just-in-time elevation and dual-authorization flow need session infrastructure decisions |
| Secure evidence vault | 5.3 | V41 | Signed URL generation and storage backend depend on object storage or local filesystem decision |
| PII blind indexing | 8.3 | V37 | HMAC key management for blind indexes follows the master key strategy |
| Crypto-shredding | 8.3, 9.1 | V38 | User encryption key store depends on key hierarchy established by PDPL controls |

**What the decision requires from hospital IT/governance:**

1. **Approved hosting location** — must be within Saudi Arabia. The PDPL data residency startup check (Section 8.3.6) refuses to boot if the database server is outside KSA.
2. **Single-hospital or multi-hospital scope** — determines schema design, tenant isolation and capacity sizing.
3. **Infrastructure ownership** — who provisions VMs/containers, manages TLS certificates, handles OS patching.
4. **Network topology** — which subnets are available for PostgreSQL, Redis, ClamAV; is outbound SMTP allowed; is the SCFHS API reachable from the hosting environment.

**Recommended action:** Prepare a one-page hosting requirements brief summarizing the system's infrastructure needs:

| Resource | Requirement | Notes |
| :--- | :--- | :--- |
| Application runtime | Node 20 LTS, 2+ vCPU, 4+ GB RAM per process | Separate API and worker processes |
| Database | PostgreSQL 15, 4+ vCPU, 8+ GB RAM | WAL archiving requires streaming replication support |
| Cache | Redis 7, 1+ GB RAM | Degradation path to PostgreSQL exists; Redis is not required for correctness |
| Malware scanning | ClamAV daemon, 2+ GB RAM | Signature updates require outbound internet access |
| SMTP relay | Hospital relay with STARTTLS on port 587 | Dedicated service account `nurseapp@aigh.sa` |
| Storage | 50 GB initial for database + evidence files | Object storage migration path specified for scale |
| Network | Private subnet for backend services; HTTPS-only public endpoint | Outbound to SCFHS API required for Phase 3 |
| Capacity context | Seeded baseline: 582 beds across 47 nursing units — capacity is fully configurable in-system, so size for the configured plan rather than the seed; estimated 800–1500 nursing staff | Peak concurrent users during scheduling windows TBD |

Present this brief to hospital IT governance with a target decision date. Escalation path: if the decision is not made by the end of Week 1, escalate to the hospital CIO or equivalent with a written impact statement citing the eight blocked subsystems.

#### 13.4.2 U2 — Credential policy and position rules

**Deadline:** Week 3 of Phase 1 (before Phase 2 staging begins).

**Why this blocks Phase 2:** The eligibility engine is implemented and working, but it enforces rules that do not yet exist for five positions. The engine treats "no rules defined" as "requirements unknown" and blocks scheduling rather than allowing it. Without rules, nurses in these positions cannot be scheduled and the Phase 2 end-to-end pilot (Section 11.3) cannot complete.

**What HR must define:**

| Position | Decision required | Example outcome |
| :--- | :--- | :--- |
| `PRACTITIONER` | Which credentials are mandatory, which are unit-scoped, and whether advanced practice scope requires additional credentials | SCFHS license + BLS + unit-specific competency |
| `NS` (Nursing Supervisor) | Mandatory credentials and any specialization-specific requirements. **Naming caution:** in the position directory `NS` = **Nursing Supervisor** (Section 3.1.1); "Nurse Specialist" is an SCFHS professional classification, not a position code | SCFHS license + ACLS + specialty certification |
| `DON` (Director of Nursing) | Leadership-tier credential requirements | SCFHS license + management qualification |
| `DEPUTY_DON` | Same scope as DON or different | Aligns with DON or slightly reduced |
| `ADMIN` | Whether admin staff require any clinical credentials or only administrative ones | Hospital ID only (non-schedulable position) |

**Additional decisions required in the same session:**

- **Grace period policy per credential template** — the recommended defaults (Section 6.1.1) are 30 days for SCFHS license, 14 days for BLS/ACLS/PALS, 30 days for passport/national ID, 0 days for hospital ID, 7 days for core competency and 0 days for medical malpractice insurance. HR must confirm or override each.
- **Policy transition timeline** — for any new credential requirements being introduced, whether to use the `TRANSITION` mode (Section 6.1.2) with a hard deadline or enforce immediately.
- **Teaching credentials for `NURSE_EDUCATOR`** — whether the newly mapped position (formerly `CI`) requires a teaching certification credential.

**Recommended action:** Schedule a 90-minute workshop with the following attendees and agenda:

| Attendee | Role in workshop |
| :--- | :--- |
| Director of Nursing (DON) | Final authority on clinical credential requirements |
| HR Admin | Defines administrative credential requirements; configures rules via the CRUD API (Section 5.1.4) |
| Clinical compliance officer | Validates regulatory requirements (SCFHS, CBAHI) |
| System administrator (NurseApp) | Captures decisions into `credential_requirements` table configuration |

**Workshop agenda:**

1. Review the position directory (Section 3.1.1) and confirm the 14 active position codes.
2. For each of the five positions without rules (`PRACTITIONER`, `NS`, `DON`, `DEPUTY_DON`, `ADMIN`), define mandatory credential templates using the catalog (Sections 5.1.1–5.1.3).
3. Confirm grace period windows per credential template.
4. Decide whether any new requirements use `TRANSITION` mode with a deadline.
5. Confirm teaching credential requirements for `NURSE_EDUCATOR`.
6. Document decisions in a signed credential policy memo for audit trail.

**Consequence of delay:** Phase 2 staging cannot complete its end-to-end pilot. The pilot scenario (Section 11.3) requires credential upload → approval → eligibility check → scheduling, all of which depend on rules existing for the test positions.

#### 13.4.3 U3 — SCFHS integration agreement

**Deadline:** Submit request by Week 2. Agreement finalization target: Week 6 (before Phase 3 pilot).

**Why start now despite Phase 3 implementation:** Government agency agreements typically take 4–12 weeks to finalize, even for straightforward API access. mTLS certificate provisioning involves the hospital's IT security team, SCFHS's PKI infrastructure, and potentially a third-party certificate authority. The Phase 3 pilot gate requires SCFHS nightly sync running without errors against 10+ practitioner records — that is not achievable without an agreement in place.

**What the agreement must cover:**

| Item | Detail | Spec reference |
| :--- | :--- | :--- |
| API access | Credentials and endpoint for the SCFHS verification API; rate limits; sandbox/staging environment access | Section 5.4 |
| mTLS certificate provisioning | Client certificate issuance for mutual TLS authentication; renewal procedures; revocation handling | Section 5.4, V30 |
| Acceptable sync frequency | How often the nightly sync (Section 5.4) can query SCFHS without triggering rate limits or IP blocking; the spec designs for this with a circuit breaker (V40) but needs the actual limits | Sections 5.4, V40 |
| Auto-suspend policy | Whether the hospital approves automatic eligibility suspension when SCFHS reports a `REVOKED` or `SUSPENDED` status, or whether it requires manual HR review first | Section 5.4 |
| Data mapping | Which SCFHS fields map to NurseApp credential fields; what the API response schema looks like; handling of name transliteration (Arabic ↔ English) | Section 5.4 |
| Failure handling | Agreed behavior when SCFHS is unreachable: the spec keeps nurses eligible for 48 hours under `STALE` status (V40) — does the hospital accept this grace window? | Sections 5.4, V40 |

**Parallel preparation (no agreement needed):** While the agreement is in progress, the development team can implement the SCFHS resilience layer (V40 — circuit breaker, sync state tracking, `STALE`/`FAILED`/`PENDING` status) and the integration service scaffold (V30) with mock responses. This means that once the agreement arrives and real API credentials are provisioned, integration is a configuration change rather than a development sprint.

**Recommended action:** Draft an SCFHS integration request letter from the hospital's medical director or chief nursing officer to SCFHS, specifying:

- **Scope** — credential verification for nursing staff at AIGH.
- **Expected volume** — initial pilot: ~50 nurses in one unit (NICU); full rollout: scaled to hospital workforce.
- **Technical requirements** — API access, mTLS client certificate, sandbox environment for staging validation.
- **Contact** — hospital IT liaison to track the request through SCFHS's process.

Assign a hospital liaison to own this request and provide weekly status updates starting from submission.

#### 13.4.4 Combined timeline impact analysis

The three urgent decisions have different blast radii and float:

| Decision | Deadline | Blocks | Float | Slip impact |
| :--- | :--- | :--- | :--- | :--- |
| Hosting (U1) | Week 1 | 8 subsystems (Phase 1 gate) | Zero | 1:1 — each week of delay shifts entire roadmap by one week |
| Credential policy (U2) | Week 3 | 3 subsystems (Phase 2 gate) | 2 weeks | Delays Phase 2 staging; Phase 1 hardening unaffected |
| SCFHS agreement (U3) | Week 2 submit | 2 subsystems (Phase 3 gate) | 4–8 weeks | Agreement process runs in parallel; delays Phase 3 pilot only if not submitted by Week 4 |

**Best case:** All three decisions land on schedule (hosting by Week 1, credential policy by Week 3, SCFHS request submitted by Week 2). The four-phase roadmap holds as written: Phase 1 closes at Week 3, Phase 2 at Week 6, Phase 3 pilot begins Week 6, production pilot gates at Week 10.

**Worst case (hosting slips to Week 4):** Phase 1 cannot close its gate (PDPL, backup, DB privileges and ClamAV all blocked). The entire downstream timeline shifts by 3 weeks: Phase 2 starts Week 7, Phase 3 pilot at Week 10, production gate at Week 14. Credential policy and SCFHS decisions become irrelevant until hosting resolves.

**Recommendation:** Track these three decisions as a standing agenda item in weekly project status meetings. Each decision should have a named hospital stakeholder owner, a target date and a documented escalation path if the target date is missed.

| Decision | Stakeholder owner | Escalation path |
| :--- | :--- | :--- |
| Hosting | Hospital CIO / IT Director | Hospital executive committee |
| Credential policy | Director of Nursing | Chief Medical Officer |
| SCFHS agreement | Medical Director | Hospital General Director |

---

## 14. Enterprise integration

### 14.1 FHIR interoperability adapter

**Specification:** To ensure the system can communicate with other hospital platforms (HIS, Payroll, Pharmacy), it implements a FHIR (Fast Healthcare Interoperability Resources) Adapter. Instead of custom JSON, the system maps internal data to the global `Practitioner` and `PractitionerRole` resources.

**Data mapping logic:**

- **Employee → Practitioner resource** — maps Name, Job Number (Identifier), and Contact.
- **Credential/License → PractitionerRole.qualifications** — maps SCFHS license and professional classification.
- **Nursing Unit/Position → PractitionerRole.specialty** — maps the employee's current unit and tier.

**Implementation — FHIR export endpoint:**

FHIR R4 models `Practitioner` and `PractitionerRole` as **two separate resources** linked by reference. (Earlier revisions returned a `practitionerRole` element inside `Practitioner`; that element does not exist in the specification, and the output failed the HL7 validator that Section 11.3 requires it to pass.)

```typescript
// src/modules/interop/fhir.controller.ts
// Both resources must pass the HL7 FHIR R4 validator (Section 11.3).
@Controller('api/v1/fhir')
@UseGuards(AuthGuard, RbacGuard)
export class FhirController {
  constructor(
    private readonly workforceService: WorkforceService,
    private readonly credentialsService: CredentialsService,
  ) {}

  @Get('Practitioner/:id')
  async getPractitionerFHIR(@Param('id') id: number) {
    const emp = await this.workforceService.getEmployee(id);

    return {
      resourceType: 'Practitioner',
      id: emp.fhirId,
      identifier: [{ system: 'http://aigh.sa/job-number', value: emp.jobNumber }],
      name: [{ family: emp.lastName, given: [emp.firstName] }],
      telecom: [{ system: 'email', value: emp.email }],
    };
  }

  @Get('PractitionerRole/:id')
  async getPractitionerRoleFHIR(@Param('id') id: number) {
    const emp = await this.workforceService.getEmployee(id);
    const creds = await this.credentialsService.getForEmployee(id);

    return {
      resourceType: 'PractitionerRole',
      id: emp.roleFhirId,
      practitioner: { reference: `Practitioner/${emp.fhirId}` },
      organization: { display: emp.unitName },
      specialty: [{ text: emp.positionTitle }],
      qualification: creds.map((c) => ({
        identifier: [{ system: 'http://scfhs.org.sa/registration', value: c.scfhsRegNumber }],
        code: { text: c.professionalClassification },
      })),
    };
  }
}
```

### 14.2 Real-time attendance integration

**Specification:** The system compares Planned Eligibility (who is scheduled) with Actual Attendance (who has clocked in). This allows supervisors to detect "Coverage Gaps" in real-time.

**The logic:**

- **Attendance feed** — the system consumes a stream of badge-swipe events from the hospital's physical access control system (PACS).
- **Gap detection** — a background worker runs every 15 minutes. It checks:
  - If a nurse is Scheduled for a shift but has not Clocked In within 30 minutes of the shift start.
  - If a nurse has Clocked In but is marked as Ineligible (e.g., license expired overnight).
- **Alerting** — if a gap is detected, a "Critical Coverage Alert" is sent to the Unit Supervisor via Push Notification.

**Implementation — gap detection query:**

```sql
-- Find nurses scheduled for the current shift who have NOT clocked in.
-- Shift start is stored as date + time in the hospital timezone; build a
-- timestamptz explicitly. The trailing 15-minute bound matches the worker
-- period, so each missing clock-in raises one alert per run window instead of
-- re-alerting for the whole shift.
SELECT e.name, sa.shift_name, sa.start_time
FROM shift_assignments sa
JOIN employees e ON sa.employee_id = e.id
WHERE sa.shift_date = (now() AT TIME ZONE 'Asia/Riyadh')::date
  AND sa.status = 'Published'
  AND ((sa.shift_date + sa.start_time) AT TIME ZONE 'Asia/Riyadh')
        <= now() + interval '30 minutes'
  AND ((sa.shift_date + sa.start_time) AT TIME ZONE 'Asia/Riyadh')
        > now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1 FROM attendance_events ae
    WHERE ae.employee_id = e.id
      AND ae.event_type = 'CLOCK_IN'
      AND ae.event_timestamp
            >= ((sa.shift_date + sa.start_time) AT TIME ZONE 'Asia/Riyadh')
  );
```

If repeat suppression must be provable rather than window-bounded, add a
`coverage_alert_log(assignment_id, window_start)` unique key and insert the
alert row in the same transaction as the push send.

### 14.3 Data portability & vendor neutrality

**Specification:** To satisfy government procurement rules and prevent vendor lock-in, the system provides a Standardized Data Export Tool. This allows the hospital to migrate their entire workforce history to another provider without loss of integrity.

**Export package components:**

- **Workforce master** — a CSV/JSON dump of all employees, including PII (decrypted for the export).
- **Contract history** — a full chronological ledger of every contract, approval, and termination.
- **Credential archive** — a mapping of all licenses and a ZIP archive of all evidence PDFs, renamed to follow a standard naming convention: `EMP_[ID]_[TEMPLATE]_[DATE].pdf`.
- **Audit manifest** — a CSV of the hash-chained audit log to prove the history's integrity to the new provider.

**Implementation — portability tool:**

```typescript
// src/modules/admin/export.service.ts
async generateHospitalExitPackage() {
  const data = await this.exportService.fetchAllWorkforceData();
  const files = await this.storageProvider.downloadAllEvidence();

  const zip = new Archiver();
  zip.append(JSON.stringify(data), { name: 'workforce_master.json' });
  zip.append(files, { name: 'evidence_archive/' });

  return zip.finalize();
}
```
