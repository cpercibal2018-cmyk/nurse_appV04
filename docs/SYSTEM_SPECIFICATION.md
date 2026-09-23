# System specification — V04

**The functional specification of V04 is the [reference specification v2.8.7](reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md), as amended by this document.**

- Where this document and the reference disagree, **this document wins**. Every amendment below is an owner decision recorded in the [decision record](V04_ARCHITECTURE_PLAN.md#9a-decision-record-2026-09-23) with its date.
- Where this document is silent, the reference applies.
- The reference is kept verbatim for traceability and is never edited. Its code samples (NestJS services, `SECURITY DEFINER` functions, Redis) describe a design that V04 did not adopt; see [ARCHITECTURE.md](ARCHITECTURE.md).
- Nothing here invents a clinical, legal, staffing or licensing rule. Where the reference has no rule, the item is listed in §4 as **REQUIREMENT NOT ESTABLISHED**.

## 1. Amendments

Each row changes what the reference says. "Spec" is the section of the reference.

| # | Spec | Reference says | V04 rule | Decision |
| :-: | :--- | :--- | :--- | :--- |
| A1 | §3.1 | Onboarding creates the employee and an **Approved** contract | Onboarding creates the employee and a **Draft** contract, atomically, with an audit entry. Coverage starts only after a different HR person approves the contract (§4.2 C2) | D-3, D-30 |
| A2 | §3.1 "Bulletproof Rule" | A `SECURITY DEFINER` database function performs onboarding; the runtime has no `INSERT` on `employees`/`contracts` | One Prisma interactive transaction performs onboarding; database constraints still enforce job-number uniqueness, contract dates and overlap | D-17 |
| A3 | §3.3 | Login accepts username or email | Login accepts the **account email** only; no username field exists | D-21 |
| A4 | §3.3 | Employees can change their own phone number | Two numbers: **mobile** and **emergency contact (next of kin)**, E.164 (`+`, 8–15 digits). The employee edits both; HR maintains both. The emergency number is seen by the employee and HR only and its value is kept out of the audit trail | D-35 |
| A5 | §6.1 check 4 | No applicable credential rule → scheduling **blocked** | No applicable rule → **allowed**, with the informational reason `NO_REQUIREMENTS_CONFIGURED` so the gap is always visible | D-4 |
| A6 | §6.1, §6.2 | Caller scope authorizes "the nurse and destination unit/post/shift" (cross-unit placement possible) | A nurse is drafted and published **only in their home unit**. Floating needs an engine change first, because the engine applies the home unit's credential rules | D-32 |
| A7 | §7.1 | Each reminder goes to the employee **and** scoped HR (N2); milestones not named | Milestones and recipients: **credentials** at 60 / 30 days → employee; 14 → + unit Supervisor; 7 and on expiry → + scoped HR. **Contracts** at 90 / 30 → employee + scoped HR; 14, 7 and on end → + Supervisor. No contract reminder once a later contract is Approved or Active. Windows unchanged (contracts 90, credentials 60) | D-39 |
| A8 | §14.2 | A shift is "missing" when there is no clock-in **at or after** the start, 30 minutes after the start | A clock-in from **30 minutes before** the start counts. Presence only — early-arrival pay rules belong to payroll | D-38 |
| A9 | §0.2, §11.4 | Node 20 LTS | Node 22 LTS or newer (Node 20 reached end-of-life in April 2026). PostgreSQL 15 unchanged | D-13 |

## 2. Clarifications

The reference is silent or open on these; the owner settled them. They add detail without contradicting the reference.

| Spec | Clarification | Decision |
| :--- | :--- | :--- |
| §3.3 | Sessions: 15-minute access token; a session not refreshed for 1 hour ends; 24-hour absolute limit through every rotation | D-6 |
| §3.3 | Login attempt limits: 5 per account and 20 per client per 15 minutes (configurable; the reference sets no numbers) | D-23 |
| §3.3 | Own sign-in history: one entry per session with sign-in and last IP and browser | D-22 |
| §3.2 | Accounts are provisioned by HR with an initial password until the invitation flow exists (it needs SMTP) | D-23 |
| §4.2 | Contract status transitions: Draft → PendingApproval → Approved/Active, return to Draft; suspend, reinstate, terminate (final); Expired only by the daily job; Superseded never set by hand | D-29 |
| §4.2 | A contract may be renewed while the current one still covers; the next period follows it directly and the overlap rule (C4) keeps them apart. V03's rule C7 (renew only after coverage lapsed) is not used | D-41 |
| §10.6 | Nightly backup at 01:00 Asia/Riyadh (22:00 UTC), scheduled independently of the host clock | D-40 |
| §5.1, §8.1 R10 | "Modifying global eligibility rules" = the hospital-wide credential catalog: every credential type change needs a second, system-wide administrator. Unit requirements apply at once | D-24, D-25 |
| §5.2 | "Subject to Renew" window stays 60 days | D-39 |
| §6.1 | An employee without a unit is ineligible (`UNIT_NOT_ASSIGNED`) | D-27 |
| §6.1.2 | Waivers: Supervisor or HR Admin only — System Admin and the break-glass account cannot issue them. A waiver covers one credential type (not all checks) and at most 72 hours | D-15, D-28 |
| §6.1 | Credential dates are checked against the shift date, not only the stored status | D-15 |
| §6.2 | Scoped Supervisors draft and publish; HR and System Admin have a read and coverage view | D-14 |
| §6.3 | No staffing formula: coverage targets are entered per unit and shift; an unset target is "unspecified", never zero | D-16 |
| §8.1 | Supervisor view of an employee ("private fields suppressed"): shown — name, job number, unit, position, job title, specialty, status, hire date, contact email, mobile phone, actual work place; hidden — salary, marital status, nationality, rank/grade, file number, job post location, emergency contact phone | D-36 |
| §8.1 | Organisation structure (departments, units, positions, CSV import) is hospital-wide configuration; unit-scoped HR manages beds and coverage targets | D-34 |
| §8.1 | Separation of duties: nobody acts on their own credential (D-26), approves a contract they created or submitted (D-30), or acts on their own contract or deletes their own employee record (D-37) | D-26, D-30, D-37 |
| §8.1 | Audit trail readable by System Admins only until HR access is decided | D-20 |
| §3.6 | Break-glass is built minimally: irrevocable event, HIGH audit, CRITICAL in-app alert to System Admins, 4-hour session. The SMS/e-mail alert to the CEO and IT Director waits for SMTP/SMS | D-9 |
| §5.3 | Uploads: magic-byte and size checks; development marks files clean; **production refuses to start without a real virus scanner, and none is built yet** | D-10 |
| §14.2 | Attendance: the gap view and 15-minute alerts are built; the badge-system (PACS) feed waits for its interface contract | D-33 |
| K1 | The Ada'a nurse-to-bed KPI is kept, labelled "thresholds not verified — MoH Ada'a card not in the repository" | D-11 |

## 3. Open conflicts

| Item | Status |
| :--- | :--- |
| — | None open. (Renewal timing was settled by D-41, the backup time by D-40.) |

## 4. REQUIREMENT NOT ESTABLISHED

The reference (and the owner, so far) gives no rule for these. V04 builds nothing that depends on them, or uses a clearly marked technical default.

| Item | V04 behaviour |
| :--- | :--- |
| Employment statuses other than "Active" | Only "Active" is used; any other value makes the employee ineligible |
| Rest, fatigue, overtime and maximum-shift rules | None enforced. Auto-fill gives at most one shift per nurse per day (a heuristic, not policy); manual drafting can add a second shift on another shift type |
| Acuity, skill mix, mandatory posts, staffing ratios | Not built |
| Agency workforce | Not built |
| Leave and absence | Not built |
| HR access to the audit trail | System Admin only (D-20) |
| Password reset | Not built (needs SMTP and an identity decision) |
| Unique contact e-mail | Not enforced (D-19) |
| Ada'a KPI thresholds | Values from V03, source card not in the repository (D-11) |
| Badge-feed contract (auth, format, delivery) | Not built (D-33) |
| Approval notification rules | None beyond the approval queue itself |

## 5. Deferred — specified, not built in V04

These stay in the reference and get their own migration and module when scheduled.

| Spec | Capability |
| :--- | :--- |
| §3.2, §7.2, §7.6 | Invitation/claim flow, SMTP e-mail, mobile push (notification rows are stored with e-mail status SKIPPED) |
| §3.5 | SSO, MFA |
| §5.3 | ClamAV scanning and the document vault (production uploads are blocked until a scanner exists) |
| §5.4 | SCFHS credential verification integration |
| §9.2 | Request-level forensic log table (JSON request logs exist, without personal data) |
| §9.3 | Redis (not used; the database is read on every request) |
| §10.4–10.5 | Blue/green deployment and production operations tooling |
| §10.7 | Database privilege separation (runtime / migration / backup / audit-reader roles). The audit table is append-only by trigger regardless of role; the role and grant script is **not written yet** — see [DEPLOYMENT.md](DEPLOYMENT.md#6-known-gaps-before-production) |
| §10.8 | Eligibility consistency auditor and observability metrics |
| §10.9 | Shadow mode |
| §10.10 | Legacy migration bridge (no V03 production data exists — [MIGRATION.md](MIGRATION.md)) |
| §14.1, §14.3 | FHIR adapter, data portability exports |

## 6. How V04 implements the rest

Where the reference describes a mechanism rather than a rule, V04 may reach the same result differently. These are design choices, not rule changes:

| Spec | Reference mechanism | V04 |
| :--- | :--- | :--- |
| §6.1 | Pool and roster read the materialized eligibility state | The state is kept (and refreshed in every transaction that changes a fact), but pool, board, auto-fill and publication run the engine live for the shift date (rule L7) — a snapshot can never clear a nurse |
| §6.1.1 | A `grace_period_log` table | Grace activation, completion and closure are HIGH audit entries |
| §9.1 | Audit hash in application code | One SQL function hashes stored columns, including the timestamp, so every row's content can be re-verified (D-7) |
| §10.2–10.3 | Separate worker with advisory locks | The same job code runs in the API (development) or a separate worker (production), each job under a lease and a unique run key |
