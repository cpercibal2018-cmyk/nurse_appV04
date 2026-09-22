# Database Consolidation

## 1. Inputs compared

| # | Source | Form | Models / tables | Used by | Validates |
| :-: | :--- | :--- | :--- | :--- | :--- |
| S1 | `server/prisma/schema.prisma` | Prisma | 14 models, 0 enums | Running API (`prisma db push`) | ✅ |
| S2 | `backend/prisma/schema.prisma` | Prisma | 34 models, 18 enums | Nothing (reference) | ✅ |
| S3 | `backend/prisma/migrations/V50_employee_hr_fields.sql` | SQL | alters `employees`, `contracts` | Nothing | n/a |
| S4 | `wave1a-kit/backend/prisma/migrations/V36b_*.sql`, `V49_worker_leases.sql` | SQL | onboarding fn, `worker_leases` + view | Nothing | n/a |
| S5 | `gate1-kit/sql/10…40_*.sql` | SQL | `audit_entries` + `fn_append_audit_entry` + `audit_chain_breaks` view, `departments`, `nursing_units`, `bed_capacity_log`, `position_directory`, `employees`, `contracts`, `credentials`, `tx_probe` | Restore drill (executed) | executed on PG 15.19 |
| S6 | Spec v2.8.7 §10.1 and inline | SQL fragments | Migrations V31–V50 (V31 grace, V32 quarantine, V33 idempotency, V35 PDPL, V36 onboarding, V39 eligibility state, V41 vault, V42 PAM/four-eyes, V44 break-glass, V48 waivers, V49 leases …) | Nothing | n/a |

**Migrations:** No Prisma migration history exists anywhere. The running system uses `prisma db push` on every container boot (`server/Dockerfile:10`). The V-numbered SQL files are loose fragments with gaps (only V36b, V49, V50 exist as files) and have never been applied as a chain.

## 2. Model-by-model comparison

✅ present · ➖ absent · ⚠ present with problems

| Concept | S1 server | S2 backend | S5 gate1 | Spec | V04 decision |
| :--- | :-: | :-: | :-: | :-: | :--- |
| Department | ✅ Int id, `createdAt String` | ✅ UUID, `nameAr` | ✅ | ✅ | Keep; Int id; `nameAr`; timestamps as timestamptz |
| Unit | ✅ `bedCount` | ✅ `bedCapacity` | ✅ `nursing_units.bed_count` + CHECK 0–500 | ✅ | Keep as `Unit` / `units`; field `bedCount`; CHECK 0–500 |
| Position | ✅ `fullTitle`, `displayOrder`, `description` | ✅ `title`, `titleAr`, no displayOrder/description | ✅ `position_directory` | ✅ | Merge both field sets; add `replacedBy` for deprecated AHN/CI (spec §3.1.1) |
| BedCapacityLog | ➖ (client only) | ✅ (`actor String`, `oldCapacity`) | ✅ | ✅ | Keep; `changedById` FK-able Int, `previousCount/newCount` (names from running app) |
| Employee | ✅ HR fields, `name`, dates as String, `unitId` default 0 | ✅ HR fields, `fullName`+`name`, `contactEmail @unique`, `unitId` required | ✅ subset | ✅ | Merge: drop redundant `name` (keep `fullName`); `unitId` **nullable** = Unassigned (C-15); `contactEmail` **not** unique until decided (C-16); indexes from V50 |
| Contract | ✅ `contractCopy Json` | ✅ enum status, `@db.Date`, no attachment | ✅ | ✅ + GiST exclusion | Merge; enum; `@db.Date`; attachments moved to `DocumentVersion`; add `approvedById/At` |
| CredentialCategory | ✅ `code` PK | ✅ `id` PK | ➖ | ✅ | Keep `code` PK |
| CredentialTemplate | ✅ `code`, `fields` | ✅ `fieldDefs`, `graceDays`, no `code` | ➖ | ✅ `grace_period_days` 0–90 | Merge: `code` unique + `fieldDefs` + `gracePeriodDays` with CHECK |
| CredentialRequirement | ✅ `unitId?`, `position?`, `isMandatory` + `policyStatus` | ✅ + `transitionDeadline` | ➖ | ✅ | Merge; drop `isMandatory` (redundant with `policyStatus`); FKs to unit/position |
| Credential | ✅ `validityStatus` String, `evidence Json` | ✅ `EmployeeCredential`, status enum (**PENDING/VALID/EXPIRING_SOON/EXPIRED/REVOKED** — no Suspended), vault fields | ✅ | ✅ 6 statuses (§5.2) | Name `Credential`; status enum = spec's 6 values; add renewal `pendingData`, grace columns (V31), `statusReason`; evidence → `DocumentVersion` |
| Contract / credential evidence | ⚠ JSON arrays on rows | ⚠ `storageKey` + checksum columns on credential only | ➖ | ✅ versioned (§5.3.1) | **New** `DocumentVersion` (one table, one owner FK, CHECK exactly one) |
| EligibilityState | ➖ | ✅ | ➖ | ✅ V39 | Keep as `EligibilityState` |
| Waiver | ➖ (client) | ✅ `EligibilityWaiver` | ➖ | ✅ `credential_waivers` + CHECKs (V48) | Keep as `CredentialWaiver`; CHECKs 72 h + future |
| Grace period | ➖ (client list) | `graceDays` on template only | ➖ | ✅ columns on credential + `grace_period_log` | Columns on `Credential`; log goes to `audit_entries` (no separate log table) |
| ShiftAssignment | ✅ `shiftName`, `startTime/endTime` strings, `status` | ✅ enum, `@@unique(unit, type, date, employee)` | ➖ | ✅ | Enum `ShiftType`; times are configuration, not columns; **partial unique (employee, date, type) where not Cancelled** (S1: stops double-booking across units, which S2's key allows) |
| Coverage targets | ➖ (formula in code) | ➖ | ➖ | ✅ "configured per unit per shift" | **New** `CoverageTarget` (C-5); no seeded values |
| CoverageAlertLog | ➖ | ✅ | ➖ | ✅ | Not in V04 phase 1 — `Notification.eventKey` dedups alerts |
| AttendanceEvent | ➖ | ✅ | ➖ | ✅ §14.2 | Keep; add `source`; unique includes `eventType` |
| Notification | ✅ no recipient | ✅ `employeeId`, bilingual, delivery status, `eventKey @unique` | ➖ | ✅ per-recipient | Keep; `recipientId` → User; unique `(recipientId, eventKey)` (global unique would block the same event for several recipients) |
| DeviceToken | ➖ | ✅ | ➖ | ✅ §7.6 | **Deferred** (push provider undecided) |
| AuditEntry | ✅ `hash/previousHash`, `isEncrypted` | ✅ `oldValue/newValue`, UUID | ✅ BIGSERIAL, `changes JSONB` | ✅ §9.1 | Keep gate1/spec shape: BigInt id, `changes`, `previousHash`, `hash`; add `requestId`, `priority` |
| User | ✅ single `role String`, `passwordHash` | ✅ `positionCode`, no password | ➖ | ✅ | Merge: credentials from S1; roles move to `RoleAssignment`; **new** `employeeId` link; drop `positionCode` (position belongs to Employee) |
| RefreshSession | ✅ | ➖ | ➖ | ✅ §3.3 | Keep from S1 |
| UserRoleAssignment | ➖ | ✅ `scopeIds String[] uuid`, `isActive` + `revokedAt` | ➖ | ✅ | `RoleAssignment`; `scopeIds Int[]`; drop `isActive` (derived from `revokedAt`/`expiresAt` — two flags could disagree) |
| AdminApprovalRequest | ➖ | ✅ | ➖ | ✅ | `ApprovalRequest` + partial unique PENDING |
| PrivilegedSession | ➖ | ✅ | ➖ | ✅ | Keep |
| BreakGlassEvent | ➖ | ✅ | ➖ | ✅ | Keep; add `expiresAt`, `endedAt` |
| IdempotencyKey | ➖ | ⚠ `key` PK (no per-actor scoping, no lease) | ➖ | ✅ + `processing_lease_expires_at` | Kit shape: unique `(key, actorUserId)`, status, lease, minimal replay payload |
| WorkerLease | ➖ | ✅ | ➖ | ✅ V49 | Keep + V49 CHECKs; `worker_lease_status` view |
| UserEncryptionKey | ➖ | ✅ | ➖ | ✅ §8.3 | **Deferred** (key management undecided, tracker B-07/B-18) |
| SystemHealthMetric, ConsistencyAuditLog, EligibilityShadowLog | ➖ | ✅ | ➖ | ✅ §10.8–10.9 | **Deferred** to the observability phase |
| ExternalApiHealth | ➖ | ✅ | ➖ | ✅ §5.4 | **Deferred** (SCFHS agreement U3) |
| FhirResourceMapping | ➖ | ✅ | ➖ | ✅ §14.1 | **Deferred** (tracker B-14) |
| RequestLog | ➖ | ✅ | ➖ | ✅ §9.2 | **Deferred**; security events recorded in `audit_entries` in phase 1 |
| MigrationValidationError, MigrationAuditLog | ➖ | ✅ | ➖ | ✅ §10.10 | **Deferred** (no legacy source identified) |
| tx_probe | ➖ | ➖ | ✅ | ➖ | Drill fixture only — stays in `ops/backup/sql` |

Deferred models are not deleted from the design. They stay described in the spec (kept under `docs/reference/`) and are added by their own migration when their feature is scheduled. Empty tables are not created ahead of their features.

## 3. Problems found in the existing schemas

| # | Problem | Where | V04 fix |
| :-: | :--- | :--- | :--- |
| P1 | Dates stored as `String` (`hireDate`, `startDate`, `expiryDate`, `shiftDate`, `createdAt` …) — no date arithmetic, no range constraint possible | S1 | `@db.Date` for calendar dates, `timestamptz` for instants |
| P2 | Almost no foreign keys (Employee→Unit/Position, Contract→Employee, Credential→Employee/Template, ShiftAssignment→* all missing) | S1 | Full relations |
| P3 | Int ids without `autoincrement` — ids assigned by the browser (`Math.max(...ids)+1`), which races between clients | S1 + `store.tsx` | `@default(autoincrement())`; server assigns ids |
| P4 | Sentinel `unitId = 0` for Unassigned cannot be a foreign key | S1, `seed.ts:16` | `unitId` nullable |
| P5 | Two names for one employee value (`name` and `fullName`) kept "for backward compat" | S2, V50 trigger sets both | Only `fullName` (trigger-maintained) |
| P6 | `isActive` and `revokedAt` both describe assignment state | S2 `UserRoleAssignment` | Keep `revokedAt` + `expiresAt` only |
| P7 | `isMandatory` and `policyStatus` both describe requirement state | S1, S2 | Keep `policyStatus` only |
| P8 | Global unique `Notification.eventKey` prevents fan-out to several recipients | S2 | `@@unique([recipientId, eventKey])` |
| P9 | `ShiftAssignment` unique key includes `unitId`, so a nurse can be double-booked in two units | S2 | Partial unique on (employee, date, type) excluding Cancelled |
| P10 | Credential status enum lacks `Suspended`, renames spec values | S2 | Spec's six statuses |
| P11 | Attachments stored as JSON arrays inside business rows; no checksum; no FK | S1 | `DocumentVersion` table |
| P12 | `User.role` single string; DEVELOPER role present | S1 | `RoleAssignment` (C-8 decision) |
| P13 | Audit hash includes a timestamp that is not stored → content unverifiable | S5 | Hash stored columns incl. `created_at` |
| P14 | Backend `AuditService` reads "last" row by `createdAt` without a lock → forked chains under concurrency | S2 service | Single SQL write path with advisory lock |
| P15 | Constraints promised in comments but never created (exclusion, partial uniques, CHECKs) | S2 | Written into the V04 migration SQL (§5) |
| P16 | `@@unique([templateId, unitId, positionCode])` with NULLs would not stop duplicates in PostgreSQL | (draft V04) | Create as `UNIQUE NULLS NOT DISTINCT` in migration SQL (PostgreSQL 15+) |
| P17 | Missing indexes for hot paths: credentials by expiry, contracts by end date (daily scan), assignments by unit+date (roster), audit by action | S1 | Added (see schema) |
| P18 | `contactEmail` unique in S2 but not S1; nothing establishes the rule | S1/S2 | Not unique pending C-16 |

## 4. Naming

| Aspect | S1 | S2 | V04 |
| :--- | :--- | :--- | :--- |
| Table names | Prisma default (PascalCase) | snake_case `@@map` | snake_case plural `@@map` |
| Column names | camelCase in DB | camelCase in DB (no `@map`) | snake_case via `@map`, because the hand-written SQL (trigger, exclusion constraint, audit fn, spec queries) is snake_case |
| Unit model | `Unit` | `Unit` | `Unit` → `units`. (gate1/spec call it `nursing_units`; the drill fixtures keep their own name.) |
| Position table | `Position` | `positions` | `positions`. (Spec calls it `position_directory`; V36b references that name — updated when ported.) |

## 5. Migration strategy (one)

1. **Prisma Migrate is the only schema path.** `prisma migrate dev` in development, `prisma migrate deploy` in CI/production. `db push` is removed from Docker and docs.
2. **Migration 0001 `init`** is generated from the V04 schema, then edited (Prisma supports hand-edited migration SQL) to append:
   - `CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS pgcrypto;`
   - Contract exclusion constraint (spec §4.2) + `end_date > start_date` + Hijri shape CHECK (V50)
   - CHECKs: `units.bed_count 0–500`, `employees.salary >= 0`, `credential_templates.grace_period_days 0–90`, `credential_waivers` 72 h + future (V48), `worker_leases` (V49), `role_assignments` scope/ids consistency, `document_versions` exactly one owner
   - Partial uniques: `role_assignments (user_id, role, scope_type) WHERE revoked_at IS NULL`; `approval_requests (initiator_id, action_type) WHERE status='PENDING'`; `shift_assignments (employee_id, shift_date, shift_type) WHERE status <> 'Cancelled'`; `credential_requirements … NULLS NOT DISTINCT`
   - Trigger `trg_employees_compose_full_name` (V50, adjusted to maintain `full_name` only)
   - `fn_append_audit_entry()` (gate1, hash over stored columns) + `audit_chain_breaks` view
   - `worker_lease_status` view (V49)
3. **Later features add their own migrations** (`0002_notifications_scan`, …). No "V-numbers" outside Prisma's folder.
4. **Database roles/grants** (spec §10.7: runtime cannot UPDATE/DELETE `audit_entries`, cannot ALTER) are **deployment-level**, applied by `ops/db/grants.sql` after `migrate deploy`, because role names and passwords differ per environment. Dev uses a single owner role.
5. **Seed:** `prisma/seed.ts` only, idempotent (upserts). Reference data always; demo data only with `SEED_DEMO=true`. Never run on container boot.

## 6. Seed consolidation

| Data | V03 sources | V04 file | Loaded when |
| :--- | :--- | :--- | :--- |
| 5 departments, 47 units / 582 beds, initial bed log | `app/src/data/seed.ts` (+ generated JSON) | `backend/prisma/seed-data/organisation.ts` | always (baseline, W3) |
| 16 positions (2 deprecated with `replacedBy`) | `seed.ts` | `…/positions.ts` | always |
| 5 categories, 16 templates **with field definitions from spec §5.1 table** (V03 seed dropped fields for templates 6–16) | `seed.ts` | `…/credential-catalog.ts` | always |
| Credential requirements | `seed.ts` (6 illustrative rows for units 13, 21) | `…/demo.ts` | demo only — **they are not hospital policy** (U2 workshop pending) |
| 8 employees, 8 contracts, 3 credentials, shifts, users | `seed.ts`, `server/prisma/seed.ts`, `store.tsx` | `…/demo.ts` | demo only |
| Demo users | `server/prisma/seed.ts` (6, shared password) | `…/demo.ts` — one per role, password from env `SEED_DEMO_PASSWORD` | demo only |
| Eligibility states, grace list, notifications, audit rows (hard-coded in `store.tsx`) | `store.tsx` | none — computed by the system | — |

## 7. Data migration from V03

V03 has no production data: the running system reseeds on every boot, and browser localStorage contains only demo data. **No data migration is required.** If any V03 database must be preserved, `docs/MIGRATION.md` will describe a one-time export/import. That need is not established.

---

## Appendix A — Proposed V04 `schema.prisma` (draft for review)

Validated with Prisma 5.22 (`prisma validate`: valid; `prisma format` applied). **26 models, 17 enums.** It lives here as a design artefact and becomes `backend/prisma/schema.prisma` only after approval.

Open points inside the draft are tied to conflicts: `Contract.status` default (C-1), `CredentialRequirement` null semantics (C-7), integer ids (C-13), `Employee.unitId` nullable (C-15), `contactEmail` not unique (C-16), and no `DEVELOPER` role (C-8).

```prisma
// AIGH Nursing Workforce Management System — V04 authoritative schema (DRAFT FOR REVIEW)
//
// One schema, one migration chain (prisma migrate). Constraints Prisma cannot
// express (exclusion constraint, partial unique indexes, CHECKs, the full-name
// trigger, fn_append_audit_entry) live in hand-written SQL inside the same
// migrations — see docs/DATABASE.md.
//
// Conventions: models PascalCase, fields camelCase, tables/columns snake_case.
// Calendar dates use @db.Date; instants use timestamptz.

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ════════════════════════════════════════════════════════════════════════════
//  Identity & access  (spec §3.3, §3.6, §8)
// ════════════════════════════════════════════════════════════════════════════

enum AppRole {
  SYSTEM_ADMIN
  HR_ADMIN
  SUPERVISOR
  // EMPLOYEE is implicit for every active user and is never stored (rule R1).
}

enum ScopeType {
  SYSTEM
  DEPARTMENT
  UNIT
}

enum ApprovalStatus {
  PENDING
  APPROVED
  REJECTED
  EXECUTED
}

model User {
  id           Int       @id @default(autoincrement())
  email        String    @unique
  displayName  String    @map("display_name")
  passwordHash String    @map("password_hash")
  isActive     Boolean   @default(true) @map("is_active")
  /// Links a login to the nurse record it may see as "own" (spec §8.1 Employee column).
  employeeId   Int?      @unique @map("employee_id")
  lastLoginAt  DateTime? @map("last_login_at") @db.Timestamptz
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  employee           Employee?          @relation(fields: [employeeId], references: [id])
  sessions           RefreshSession[]
  roleAssignments    RoleAssignment[]   @relation("assignee")
  grantedAssignments RoleAssignment[]   @relation("granter")
  revokedAssignments RoleAssignment[]   @relation("revoker")
  approvalsInitiated ApprovalRequest[]  @relation("initiator")
  approvalsDecided   ApprovalRequest[]  @relation("approver")
  privilegedSession  PrivilegedSession?
  notifications      Notification[]

  @@map("users")
}

model RefreshSession {
  id        String    @id // opaque id carried in the cookie
  userId    Int       @map("user_id")
  tokenHash String    @map("token_hash") // sha256 of the secret; raw value never stored
  familyId  String    @map("family_id") // reuse of a rotated token revokes the family
  expiresAt DateTime  @map("expires_at") @db.Timestamptz
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([familyId])
  @@map("refresh_sessions")
}

/// Scoped, time-boxed grant of an application role (spec §8, rules R1–R12).
/// SQL: partial unique (user_id, role, scope_type) WHERE revoked_at IS NULL;
///      CHECK scope_type = 'SYSTEM' <=> cardinality(scope_ids) = 0.
model RoleAssignment {
  id                Int       @id @default(autoincrement())
  userId            Int       @map("user_id")
  role              AppRole
  scopeType         ScopeType @map("scope_type")
  /// Department ids (DEPARTMENT) or unit ids (UNIT); empty for SYSTEM.
  scopeIds          Int[]     @map("scope_ids")
  reason            String
  grantedById       Int       @map("granted_by_id")
  grantedAt         DateTime  @default(now()) @map("granted_at") @db.Timestamptz
  expiresAt         DateTime? @map("expires_at") @db.Timestamptz
  revokedById       Int?      @map("revoked_by_id")
  revokedAt         DateTime? @map("revoked_at") @db.Timestamptz
  revokeReason      String?   @map("revoke_reason")
  approvalRequestId Int?      @map("approval_request_id")

  user            User             @relation("assignee", fields: [userId], references: [id])
  grantedBy       User             @relation("granter", fields: [grantedById], references: [id])
  revokedBy       User?            @relation("revoker", fields: [revokedById], references: [id])
  approvalRequest ApprovalRequest? @relation(fields: [approvalRequestId], references: [id])

  @@index([userId, revokedAt])
  @@index([role, scopeType])
  @@map("role_assignments")
}

/// Four-eyes request (spec §8.1, rules R10–R12).
/// SQL: partial unique (initiator_id, action_type) WHERE status = 'PENDING'.
model ApprovalRequest {
  id          Int            @id @default(autoincrement())
  initiatorId Int            @map("initiator_id")
  approverId  Int?           @map("approver_id")
  actionType  String         @map("action_type")
  payload     Json
  status      ApprovalStatus @default(PENDING)
  reason      String?
  createdAt   DateTime       @default(now()) @map("created_at") @db.Timestamptz
  decidedAt   DateTime?      @map("decided_at") @db.Timestamptz
  executedAt  DateTime?      @map("executed_at") @db.Timestamptz

  initiator   User             @relation("initiator", fields: [initiatorId], references: [id])
  approver    User?            @relation("approver", fields: [approverId], references: [id])
  assignments RoleAssignment[]

  @@index([status])
  @@map("approval_requests")
}

/// PAM just-in-time elevation (spec §8.1, rule R13).
model PrivilegedSession {
  userId       Int      @id @map("user_id")
  reason       String
  elevatedAt   DateTime @default(now()) @map("elevated_at") @db.Timestamptz
  expiresAt    DateTime @map("expires_at") @db.Timestamptz
  authorizedBy Int?     @map("authorized_by")

  user User @relation(fields: [userId], references: [id])

  @@map("privileged_sessions")
}

/// Break-glass siren (spec §3.6, rule R18). Runtime role: INSERT/SELECT only.
model BreakGlassEvent {
  id          Int       @id @default(autoincrement())
  actorUserId Int       @map("actor_user_id")
  reason      String
  ipAddress   String    @map("ip_address")
  activatedAt DateTime  @default(now()) @map("activated_at") @db.Timestamptz
  expiresAt   DateTime  @map("expires_at") @db.Timestamptz // activated_at + 4 h
  endedAt     DateTime? @map("ended_at") @db.Timestamptz

  @@map("break_glass_events")
}

// ════════════════════════════════════════════════════════════════════════════
//  Organisation & workforce  (spec §2.9, §3.1.1, §6.3)
// ════════════════════════════════════════════════════════════════════════════

model Department {
  id          Int      @id @default(autoincrement())
  code        String   @unique
  name        String
  nameAr      String?  @map("name_ar")
  description String?
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt   DateTime @updatedAt @map("updated_at") @db.Timestamptz

  units Unit[]

  @@map("departments")
}

/// SQL: CHECK (bed_count BETWEEN 0 AND 500)  (rule W4)
model Unit {
  id           Int      @id @default(autoincrement())
  code         String   @unique
  name         String
  nameAr       String?  @map("name_ar")
  description  String?
  departmentId Int      @map("department_id")
  bedCount     Int      @default(0) @map("bed_count")
  isActive     Boolean  @default(true) @map("is_active")
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz

  department             Department              @relation(fields: [departmentId], references: [id])
  employees              Employee[]
  bedCapacityLogs        BedCapacityLog[]
  coverageTargets        CoverageTarget[]
  credentialRequirements CredentialRequirement[]
  shiftAssignments       ShiftAssignment[]

  @@index([departmentId])
  @@map("units")
}

model BedCapacityLog {
  id            Int      @id @default(autoincrement())
  unitId        Int      @map("unit_id")
  previousCount Int      @map("previous_count")
  newCount      Int      @map("new_count")
  reason        String
  changedById   Int?     @map("changed_by_id") // null = seed / system
  changedAt     DateTime @default(now()) @map("changed_at") @db.Timestamptz

  unit Unit @relation(fields: [unitId], references: [id])

  @@index([unitId, changedAt])
  @@map("bed_capacity_logs")
}

/// Position directory (spec §3.1.1). Never confers an authorization role (R14).
model Position {
  code          String   @id
  title         String
  titleAr       String?  @map("title_ar")
  tier          String
  description   String?
  isSchedulable Boolean  @map("is_schedulable")
  isActive      Boolean  @default(true) @map("is_active")
  displayOrder  Int      @default(0) @map("display_order")
  replacedBy    String?  @map("replaced_by") // deprecated codes: AHN -> ACTING_HEAD, CI -> NURSE_EDUCATOR
  createdAt     DateTime @default(now()) @map("created_at") @db.Timestamptz
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz

  employees              Employee[]
  credentialRequirements CredentialRequirement[]

  @@map("positions")
}

enum ShiftType {
  Morning
  Evening
  Night
}

/// Configured minimum staff per unit per shift (spec L813, §6.3, rule W8).
/// No row = target "unspecified" — never treated as zero. No values are seeded:
/// staffing minimums are REQUIREMENT NOT ESTABLISHED until the hospital supplies them.
model CoverageTarget {
  id           Int       @id @default(autoincrement())
  unitId       Int       @map("unit_id")
  shiftType    ShiftType @map("shift_type")
  minimumStaff Int       @map("minimum_staff")
  updatedById  Int?      @map("updated_by_id")
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz

  unit Unit @relation(fields: [unitId], references: [id])

  @@unique([unitId, shiftType])
  @@map("coverage_targets")
}

// ════════════════════════════════════════════════════════════════════════════
//  Nurse master  (spec §3.1)
// ════════════════════════════════════════════════════════════════════════════

enum MaritalStatus {
  Single
  Married
  Others
}

/// SQL: trigger trg_employees_compose_full_name (rule E3); CHECK salary >= 0.
model Employee {
  id              Int            @id @default(autoincrement())
  jobNumber       String         @unique @map("job_number") // no format rule (E1)
  firstName       String         @map("first_name")
  middleName      String?        @map("middle_name")
  lastName        String         @map("last_name")
  fullName        String         @map("full_name") // derived by trigger — never supplied
  jobTitle        String?        @map("job_title")
  fileNo          String?        @map("file_no") // not unique (E8)
  rankGrade       String?        @map("rank_grade")
  nationality     String?
  jobPostLocation String?        @map("job_post_location")
  actualWorkPlace String?        @map("actual_work_place")
  specialty       String?
  maritalStatus   MaritalStatus? @map("marital_status")
  salary          Decimal?       @db.Decimal(12, 2) // SAR
  contactEmail    String         @map("contact_email")
  /// null = Unassigned (replaces the V03 sentinel unit id 0).
  unitId          Int?           @map("unit_id")
  positionCode    String         @map("position_code")
  /// Employment status values beyond "Active" are REQUIREMENT NOT ESTABLISHED.
  status          String         @default("Active")
  hireDate        DateTime?      @map("hire_date") @db.Date
  deletedAt       DateTime?      @map("deleted_at") @db.Timestamptz
  createdAt       DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt       DateTime       @updatedAt @map("updated_at") @db.Timestamptz

  unit             Unit?              @relation(fields: [unitId], references: [id])
  position         Position           @relation(fields: [positionCode], references: [code])
  user             User?
  contracts        Contract[]
  credentials      Credential[]
  waivers          CredentialWaiver[]
  eligibilityState EligibilityState?
  shiftAssignments ShiftAssignment[]
  attendanceEvents AttendanceEvent[]

  @@index([unitId])
  @@index([positionCode])
  @@index([nationality])
  @@index([specialty])
  @@index([fileNo])
  @@map("employees")
}

// ════════════════════════════════════════════════════════════════════════════
//  Contracts  (spec §4)
// ════════════════════════════════════════════════════════════════════════════

enum ContractStatus {
  Draft
  PendingApproval
  Approved
  Active
  Expired
  Suspended
  Terminated
  Superseded
}

/// SQL: EXCLUDE USING gist (employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&)
///      WHERE (status IN ('Approved','Active'))  (rule C4);
///      CHECK end_date > start_date; CHECK Hijri shape.
model Contract {
  id             Int            @id @default(autoincrement())
  employeeId     Int            @map("employee_id")
  jobNumber      String         @map("job_number") // denormalised for traceability (spec §3.1)
  startDate      DateTime       @map("start_date") @db.Date // Gregorian — authoritative
  endDate        DateTime       @map("end_date") @db.Date
  startDateHijri String?        @map("start_date_hijri") @db.VarChar(10)
  endDateHijri   String?        @map("end_date_hijri") @db.VarChar(10)
  status         ContractStatus @default(Draft)
  approvedById   Int?           @map("approved_by_id")
  approvedAt     DateTime?      @map("approved_at") @db.Timestamptz
  createdAt      DateTime       @default(now()) @map("created_at") @db.Timestamptz
  updatedAt      DateTime       @updatedAt @map("updated_at") @db.Timestamptz

  employee  Employee          @relation(fields: [employeeId], references: [id])
  documents DocumentVersion[]

  @@index([employeeId, status])
  @@index([endDate])
  @@map("contracts")
}

// ════════════════════════════════════════════════════════════════════════════
//  Credentials  (spec §5)
// ════════════════════════════════════════════════════════════════════════════

enum CredentialStatus {
  PendingVerification
  Valid
  ExpiringSoon
  Expired
  Suspended
  Revoked
}

enum PolicyStatus {
  MANDATORY
  TRANSITION
  OPTIONAL
}

enum SyncStatus {
  SYNCED
  STALE
  FAILED
  PENDING
}

model CredentialCategory {
  code         String  @id // IDENTITY | LICENSURE | LIABILITY | COMPETENCY | LIFE_SUPPORT
  name         String
  description  String?
  displayOrder Int     @default(0) @map("display_order")

  templates CredentialTemplate[]

  @@map("credential_categories")
}

/// SQL: CHECK (grace_period_days BETWEEN 0 AND 90)  (rule L8)
model CredentialTemplate {
  id              Int      @id @default(autoincrement())
  code            String   @unique
  name            String
  categoryCode    String   @map("category_code")
  description     String?
  hasExpiry       Boolean  @default(true) @map("has_expiry")
  requiresUpload  Boolean  @default(true) @map("requires_upload")
  /// [{key,label,type,required,isIssueDate?,isExpiryDate?}] — spec §5.1
  fieldDefs       Json     @default("[]") @map("field_defs")
  gracePeriodDays Int      @default(0) @map("grace_period_days")
  displayOrder    Int      @default(0) @map("display_order")
  isActive        Boolean  @default(true) @map("is_active")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz

  category     CredentialCategory      @relation(fields: [categoryCode], references: [code])
  requirements CredentialRequirement[]
  credentials  Credential[]
  waivers      CredentialWaiver[]

  @@map("credential_templates")
}

/// A mandatory/transition rule. unitId null = all units; positionCode null = all
/// positions (conflict C-7 — to be confirmed).
model CredentialRequirement {
  id                 Int          @id @default(autoincrement())
  templateId         Int          @map("template_id")
  unitId             Int?         @map("unit_id")
  positionCode       String?      @map("position_code")
  policyStatus       PolicyStatus @default(MANDATORY) @map("policy_status")
  transitionDeadline DateTime?    @map("transition_deadline") @db.Date
  createdAt          DateTime     @default(now()) @map("created_at") @db.Timestamptz

  template CredentialTemplate @relation(fields: [templateId], references: [id])
  unit     Unit?              @relation(fields: [unitId], references: [id])
  position Position?          @relation(fields: [positionCode], references: [code])

  @@unique([templateId, unitId, positionCode])
  @@map("credential_requirements")
}

model Credential {
  id               Int              @id @default(autoincrement())
  employeeId       Int              @map("employee_id")
  templateId       Int              @map("template_id")
  status           CredentialStatus @default(PendingVerification)
  issueDate        DateTime?        @map("issue_date") @db.Date
  expiryDate       DateTime?        @map("expiry_date") @db.Date
  expiryDateHijri  String?          @map("expiry_date_hijri") @db.VarChar(10)
  /// Template-defined tracked fields (e.g. scfhs_number). PII fields are candidates for §8.3 encryption.
  trackingData     Json             @default("{}") @map("tracking_data")
  /// Renewal staging (spec §5.2): replacement values awaiting HR review.
  pendingData      Json?            @map("pending_data")
  verifiedById     Int?             @map("verified_by_id")
  verifiedAt       DateTime?        @map("verified_at") @db.Timestamptz
  statusReason     String?          @map("status_reason")
  graceActivatedAt DateTime?        @map("grace_activated_at") @db.Timestamptz
  graceExpiryDate  DateTime?        @map("grace_expiry_date") @db.Date
  graceCycleId     String?          @map("grace_cycle_id") // prevents stacking (L8)
  syncStatus       SyncStatus?      @map("sync_status")
  lastSyncAt       DateTime?        @map("last_sync_at") @db.Timestamptz
  createdAt        DateTime         @default(now()) @map("created_at") @db.Timestamptz
  updatedAt        DateTime         @updatedAt @map("updated_at") @db.Timestamptz

  employee  Employee           @relation(fields: [employeeId], references: [id])
  template  CredentialTemplate @relation(fields: [templateId], references: [id])
  documents DocumentVersion[]

  @@index([employeeId, status])
  @@index([expiryDate])
  @@map("credentials")
}

enum ScanStatus {
  PENDING
  CLEAN
  INFECTED
}

/// Append-only versioned evidence for contracts and credentials (rules D1–D4).
/// SQL: CHECK exactly one of contract_id / credential_id is set.
model DocumentVersion {
  id           Int        @id @default(autoincrement())
  contractId   Int?       @map("contract_id")
  credentialId Int?       @map("credential_id")
  version      Int
  fileName     String     @map("file_name")
  mimeType     String     @map("mime_type")
  sizeBytes    Int        @map("size_bytes")
  sha256       String
  storageKey   String     @unique @map("storage_key") // never exposed as a URL
  scanStatus   ScanStatus @default(PENDING) @map("scan_status")
  uploadedById Int?       @map("uploaded_by_id")
  uploadedAt   DateTime   @default(now()) @map("uploaded_at") @db.Timestamptz

  contract   Contract?   @relation(fields: [contractId], references: [id])
  credential Credential? @relation(fields: [credentialId], references: [id])

  @@unique([contractId, version])
  @@unique([credentialId, version])
  @@map("document_versions")
}

// ════════════════════════════════════════════════════════════════════════════
//  Eligibility  (spec §6.1)
// ════════════════════════════════════════════════════════════════════════════

enum EligibilityStatus {
  ELIGIBLE
  ELIGIBLE_WITH_GRACE
  INELIGIBLE
}

/// Materialized state, one row per employee (spec §6.1 / V39).
model EligibilityState {
  employeeId     Int               @id @map("employee_id")
  status         EligibilityStatus
  reasons        Json              @default("[]") // [{code, message, templateId?}]
  calculatedAt   DateTime          @default(now()) @map("calculated_at") @db.Timestamptz
  updatedByEvent String?           @map("updated_by_event")
  logicVersion   Int               @default(1) @map("logic_version")

  employee Employee @relation(fields: [employeeId], references: [id])

  @@index([status])
  @@map("eligibility_states")
}

/// Emergency waiver (spec §6.1.2, rule L9).
/// SQL: CHECK expires_at <= created_at + interval '72 hours';
///      CHECK expires_at > created_at.
model CredentialWaiver {
  id         Int      @id @default(autoincrement())
  employeeId Int      @map("employee_id")
  templateId Int      @map("template_id")
  waivedById Int      @map("waived_by_id")
  reason     String
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz
  expiresAt  DateTime @map("expires_at") @db.Timestamptz

  employee Employee           @relation(fields: [employeeId], references: [id])
  template CredentialTemplate @relation(fields: [templateId], references: [id])

  @@index([employeeId, expiresAt])
  @@map("credential_waivers")
}

// ════════════════════════════════════════════════════════════════════════════
//  Scheduling  (spec §6.2–6.3)
// ════════════════════════════════════════════════════════════════════════════

enum AssignmentStatus {
  Draft
  Published
  Cancelled
}

/// SQL: partial unique (employee_id, shift_date, shift_type) WHERE status <> 'Cancelled'
///      — one shift slot per nurse per day regardless of unit (rule S1).
model ShiftAssignment {
  id                   Int                @id @default(autoincrement())
  employeeId           Int                @map("employee_id")
  unitId               Int                @map("unit_id")
  shiftDate            DateTime           @map("shift_date") @db.Date
  shiftType            ShiftType          @map("shift_type")
  status               AssignmentStatus   @default(Draft)
  notes                String?
  /// Set when the assignment relied on a grace period or waiver (never silent — L8).
  eligibilityAtPublish EligibilityStatus? @map("eligibility_at_publish")
  createdById          Int?               @map("created_by_id")
  publishedById        Int?               @map("published_by_id")
  publishedAt          DateTime?          @map("published_at") @db.Timestamptz
  createdAt            DateTime           @default(now()) @map("created_at") @db.Timestamptz
  updatedAt            DateTime           @updatedAt @map("updated_at") @db.Timestamptz

  employee Employee @relation(fields: [employeeId], references: [id])
  unit     Unit     @relation(fields: [unitId], references: [id])

  @@index([unitId, shiftDate])
  @@index([shiftDate])
  @@map("shift_assignments")
}

// ════════════════════════════════════════════════════════════════════════════
//  Attendance  (spec §14.2 — clock events only; states/leave NOT ESTABLISHED)
// ════════════════════════════════════════════════════════════════════════════

enum AttendanceEventType {
  CLOCK_IN
  CLOCK_OUT
  BREAK_START
  BREAK_END
}

model AttendanceEvent {
  id             Int                 @id @default(autoincrement())
  employeeId     Int                 @map("employee_id")
  eventType      AttendanceEventType @map("event_type")
  eventTimestamp DateTime            @map("event_timestamp") @db.Timestamptz
  source         String? // badge / PACS feed identifier
  deviceId       String?             @map("device_id")
  locationCode   String?             @map("location_code")
  createdAt      DateTime            @default(now()) @map("created_at") @db.Timestamptz

  employee Employee @relation(fields: [employeeId], references: [id])

  @@unique([employeeId, eventTimestamp, eventType])
  @@map("attendance_events")
}

// ════════════════════════════════════════════════════════════════════════════
//  Notifications  (spec §7)
// ════════════════════════════════════════════════════════════════════════════

enum NotificationType {
  CONTRACT
  CREDENTIAL
  COVERAGE
  ELIGIBILITY
  APPROVAL
  SECURITY
  SYSTEM
}

enum NotificationPriority {
  CRITICAL
  HIGH
  MEDIUM
  LOW
}

enum DeliveryStatus {
  PENDING
  SENT
  FAILED
  SKIPPED
}

/// One row per recipient (spec §7.1, rule N2). eventKey dedups rescans (N3).
model Notification {
  id            Int                  @id @default(autoincrement())
  recipientId   Int                  @map("recipient_id")
  employeeId    Int?                 @map("employee_id") // subject of the event, if any
  type          NotificationType
  priority      NotificationPriority @default(MEDIUM)
  title         String
  message       String
  titleAr       String?              @map("title_ar")
  messageAr     String?              @map("message_ar")
  eventKey      String?              @map("event_key")
  readAt        DateTime?            @map("read_at") @db.Timestamptz
  emailStatus   DeliveryStatus       @default(SKIPPED) @map("email_status")
  emailAttempts Int                  @default(0) @map("email_attempts")
  emailLastAt   DateTime?            @map("email_last_at") @db.Timestamptz
  createdAt     DateTime             @default(now()) @map("created_at") @db.Timestamptz

  recipient User @relation(fields: [recipientId], references: [id])

  @@unique([recipientId, eventKey])
  @@index([recipientId, readAt])
  @@map("notifications")
}

// ════════════════════════════════════════════════════════════════════════════
//  Audit  (spec §9.1) — written ONLY through fn_append_audit_entry()
// ════════════════════════════════════════════════════════════════════════════

model AuditEntry {
  id           BigInt   @id @default(autoincrement())
  actorUserId  Int?     @map("actor_user_id") // null = system job
  action       String
  resource     String
  resourceId   String?  @map("resource_id")
  changes      Json     @default("{}")
  requestId    String?  @map("request_id")
  priority     String   @default("NORMAL") // NORMAL | HIGH (waivers, break-glass, role changes)
  previousHash String?  @map("previous_hash")
  hash         String
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz

  @@index([resource, resourceId, createdAt])
  @@index([actorUserId, createdAt])
  @@index([action, createdAt])
  @@map("audit_entries")
}

// ════════════════════════════════════════════════════════════════════════════
//  Platform  (spec §9.5 idempotency, §10.3 worker leases)
// ════════════════════════════════════════════════════════════════════════════

enum IdempotencyStatus {
  PROCESSING
  COMPLETED
  FAILED
}

model IdempotencyKey {
  id                       Int               @id @default(autoincrement())
  key                      String
  actorUserId              Int               @map("actor_user_id")
  operation                String
  requestPath              String            @map("request_path")
  requestHash              String            @map("request_hash")
  status                   IdempotencyStatus
  processingLeaseExpiresAt DateTime?         @map("processing_lease_expires_at") @db.Timestamptz
  responseCode             Int?              @map("response_code")
  responseBody             Json?             @map("response_body") // identifiers only — no PII
  responseHash             String?           @map("response_hash")
  createdAt                DateTime          @default(now()) @map("created_at") @db.Timestamptz
  completedAt              DateTime?         @map("completed_at") @db.Timestamptz
  expiresAt                DateTime          @map("expires_at") @db.Timestamptz

  @@unique([key, actorUserId])
  @@index([expiresAt])
  @@map("idempotency_keys")
}

/// SQL: CHECK lease_seconds BETWEEN 30 AND 3600; CHECK expires_at > acquired_at (V49).
model WorkerLease {
  jobName      String   @id @map("job_name")
  holderId     String   @map("holder_id") @db.Uuid
  acquiredAt   DateTime @default(now()) @map("acquired_at") @db.Timestamptz
  heartbeatAt  DateTime @default(now()) @map("heartbeat_at") @db.Timestamptz
  expiresAt    DateTime @map("expires_at") @db.Timestamptz
  leaseSeconds Int      @default(300) @map("lease_seconds")

  @@index([expiresAt])
  @@map("worker_leases")
}
```
