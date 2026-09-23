# Database

PostgreSQL 15. The schema is [`backend/prisma/schema.prisma`](../backend/prisma/schema.prisma); the only way it changes is a migration in [`backend/prisma/migrations/`](../backend/prisma/migrations/). The consolidation that produced this schema from V03's four sources is recorded in [DATABASE_CONSOLIDATION.md](DATABASE_CONSOLIDATION.md).

## 1. Conventions

- Tables and columns are `snake_case` (`@@map` / `@map`); Prisma models are `PascalCase`.
- Ids are integer auto-increment (D-8).
- **Timestamps** are `timestamptz` and every connection pins `TimeZone=UTC` (`lib/prisma.ts`). Prisma 7's pg adapter sends dates without an offset, so a server in another time zone would otherwise store them shifted; a regression test forces an Asia/Riyadh connection.
- **Calendar dates** (shift, contract, credential dates) are `date` columns and are compared as Asia/Riyadh days. The expiry or end date is the **last valid day**.
- Umm al-Qura Hijri equivalents are stored beside contract and credential dates (`YYYY-MM-DD`, shape-checked); the Gregorian date is authoritative.
- Soft delete: `employees.deleted_at`. No other business table deletes rows.

## 2. Tables (27)

| Area | Tables |
| :--- | :--- |
| Identity and access | `users`, `refresh_sessions`, `role_assignments`, `approval_requests`, `privileged_sessions`, `break_glass_events` |
| Organisation | `departments`, `units`, `bed_capacity_logs`, `positions`, `coverage_targets` |
| Workforce | `employees`, `contracts` |
| Credentials | `credential_categories`, `credential_templates`, `credential_requirements`, `credentials`, `document_versions` |
| Eligibility | `eligibility_states`, `credential_waivers` |
| Scheduling and attendance | `shift_assignments`, `attendance_events` |
| Platform | `notifications`, `audit_entries`, `idempotency_keys`, `worker_leases`, `job_runs` |

The field-level definition is the schema file itself; it is commented where a column carries a rule.

## 3. Constraints the database enforces

Prisma cannot express these, so they are hand-written in migration SQL. They are the last line of defence: each service checks the same rule first and returns a readable error, but a bug or a direct SQL write still cannot break them. `backend/test/database-constraints.test.ts` proves the important ones.

| Rule | Constraint | Migration |
| :--- | :--- | :--- |
| C4: no overlapping Approved/Active contracts per employee (inclusive dates) | `no_overlapping_active_contracts` (exclusion, `btree_gist`) | `init` |
| C5: contract end after start | `chk_contracts_dates` | `init` |
| Hijri date shape | `chk_contracts_hijri_shape`, `chk_credentials_hijri_shape` | `init` |
| W4: beds 0–500 | `chk_units_bed_count` | `init` |
| W8: coverage minimum ≥ 0 | `chk_coverage_targets_minimum` | `init` |
| E7: salary ≥ 0 | `chk_employees_salary` | `init` |
| E1: job number unique regardless of case | unique index on `lower(job_number)` | `init` |
| E3: full name derived from first + middle + last, never typed | trigger `trg_employees_compose_full_name` | `init` |
| D-35: phones in E.164 | `employees_primary_phone_e164`, `employees_emergency_contact_phone_e164` | `employee_phones` |
| L8: grace 0–90 days | `chk_credential_templates_grace` | `init` |
| §5.1.4: one requirement per template + unit + position (position `NULL` = every position) | unique index `NULLS NOT DISTINCT` | `init` |
| Credential issue ≤ expiry | `chk_credentials_dates` | `init` |
| L9: waiver lasts at most 72 hours | `chk_waiver_future`, `chk_waiver_max_window` | `init` |
| D2: a document belongs to exactly one contract or credential, 1 byte – 10 MB | `chk_document_versions_one_owner`, `chk_document_versions_size` | `init` |
| R3: `SYSTEM` scope ⇔ no scope ids; expiry after grant | `chk_role_assignments_scope`, `chk_role_assignments_expiry` | `init` |
| R7: one active assignment per user + role + scope type | partial unique `role_assignments_active_key` | `init` |
| R11: one pending request per initiator + action | partial unique `approval_requests_pending_key` | `init` |
| S1: one slot per nurse per date and shift, across units | partial unique `shift_assignments_employee_slot_key` (cancelled rows excluded) | `init` |
| N3: one notification per recipient + event key | unique (`recipient_id`, `event_key`) | `init` |
| R18: break-glass events cannot be deleted | trigger `trg_break_glass_events_no_delete` | `init` |
| Audit append-only (A2) | trigger `trg_audit_entries_append_only` | `init` |
| Job runs claimed once per period | unique `job_runs.run_key` | `session_meta_and_job_runs` |
| Worker lease 30–3600 s | `chk_lease_seconds`, `chk_lease_expiry`; view `worker_lease_status` | `init` |

## 4. Audit chain

| Object | Purpose |
| :--- | :--- |
| `fn_audit_hash(...)` | SHA-256 over the previous hash and the stored columns, **including** `created_at` (D-7), so a row's content can be re-verified later |
| `fn_append_audit_entry(...)` | The single write path. Takes a transaction-scoped advisory lock so concurrent transactions cannot fork the chain; called inside the business transaction, so the audit row commits or rolls back with the change |
| `trg_audit_entries_append_only` | Rejects `UPDATE` and `DELETE` for every role, independent of grants |
| `audit_chain_breaks` (view) | Rows whose link (`BROKEN_LINK`) or content (`CONTENT_MISMATCH`) fails. Expected: empty. Served by `GET /api/v1/audit/verify` |

Values kept out of the audit trail on purpose: salary and the emergency contact phone (only the fact that they changed is recorded).

## 5. Migrations

| Migration | Adds |
| :--- | :--- |
| `20260922224327_init` | Every table, enum and index, plus the hand-written constraints, triggers, functions and views above |
| `20260923060000_credential_review_and_policy_warning` | `ELIGIBLE_WITH_POLICY_WARNING`, evidence review status and reviewer, `credentials.latest_evidence_id` |
| `20260923120000_contract_actors` | `contracts.created_by_id`, `submitted_by_id` (D-30) |
| `20260923180000_session_meta_and_job_runs` | Session IP and browser (D-22); `job_runs` |
| `20260924090000_employee_phones` | `employees.primary_phone`, `emergency_contact_phone` with E.164 checks (D-35) |

**Rules**

- Development: `npm run db:migrate -w backend` (`prisma migrate dev`) after editing `schema.prisma`. Hand-written SQL goes at the end of the generated file, under a comment explaining the rule.
- CI and production: `npm run db:deploy -w backend` (`prisma migrate deploy`). CI runs it twice to prove there is no drift.
- `prisma db push` is never used. A migration that has been applied anywhere is never edited; fix forward with a new one.
- Status: `npm run db:status -w backend`.

## 6. Seed

`npm run db:seed -w backend` (`prisma/seed.ts`) is the only seed and is idempotent: existing rows are left alone, so HR's changes survive a re-run.

| Data | When |
| :--- | :--- |
| Departments, units, positions, credential categories and types (`seed-data/organisation.ts`, `positions.ts`, `credential-catalog.ts`) | Always |
| Demo employees, contracts, credentials, requirements and one user per role (`seed-data/demo.ts`) | Only with `SEED_DEMO=true` and `SEED_DEMO_PASSWORD`; refused when `NODE_ENV=production` |

## 7. Database roles (not yet written)

Spec §10.7 separates the runtime, migration, backup and audit-reader roles (the runtime may not alter the schema). V04 currently connects with one owner role in every environment. The audit table is protected by trigger regardless, but the role and grant script (`ops/db/grants.sql` in the plan) **has not been written**. This is a production prerequisite — [DEPLOYMENT.md §6](DEPLOYMENT.md#6-known-gaps-before-production).
