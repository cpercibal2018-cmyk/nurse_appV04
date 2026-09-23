# Database Consolidation

> **Historical (stage-1 analysis of V03, 2026-09-22).** Kept for traceability; it describes V03 and the plan for V04, not V04 as built. For V04 see [docs/README.md](../README.md). Content unchanged since it was retired in commit 12, except that relative links were adjusted for the move.

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

## Appendix A — V04 schema

The schema proposed here was reviewed and is now implemented as the **only** schema: [`backend/prisma/schema.prisma`](../../backend/prisma/schema.prisma), with its constraints in [`backend/prisma/migrations/`](../../backend/prisma/migrations/). The draft copy that used to be in this appendix was removed so that two schema texts cannot drift apart.

Changes made while implementing the draft:

| Change | Reason |
| :--- | :--- |
| `CredentialRequirement.unitId` is required | Spec §5.1.4: a requirement links a template to "a unit (required)" and optionally a position. This corrects recommendation D-18, which came from the V03 NestJS schema |
| `User.isBreakGlass` added | Decision D-9 (break-glass account flag) |
| `RefreshSession.absoluteExpiresAt` added | Decision D-6 (24 h absolute session limit survives token rotation) |
| Prisma 7 generator (`prisma-client`, output `src/generated/prisma`) and `prisma.config.ts` | Prisma 7 moves the connection URL out of the schema |
| Case-insensitive unique index on `lower(job_number)` | Rule E1 as V03 enforced it |
| Append-only trigger on `audit_entries`, no-delete trigger on `break_glass_events` | Rules A2 and R18 enforced independently of deployment grants |
