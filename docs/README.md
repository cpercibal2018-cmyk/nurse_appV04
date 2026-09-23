# Documentation

## The authoritative set

| Document | Read it for |
| :--- | :--- |
| [SYSTEM_SPECIFICATION.md](SYSTEM_SPECIFICATION.md) | **What the system must do**: the reference specification plus every owner amendment, clarification, open conflict and REQUIREMENT NOT ESTABLISHED item |
| [ARCHITECTURE.md](ARCHITECTURE.md) | How it is built: components, layout, modules, request flow, jobs, tests |
| [RBAC.md](RBAC.md) | Roles, scopes, the permission table (checked against the code by a test), field visibility, separation of duties, PAM, break-glass |
| [CLINICAL_ELIGIBILITY.md](CLINICAL_ELIGIBILITY.md) | Credentials, the eligibility engine, grace, waivers, policy transitions, reminders |
| [WORKFORCE.md](WORKFORCE.md) | Organisation, employees, contracts, scheduling, attendance |
| [API.md](API.md) | Every endpoint, with permission, scope and source |
| [DATABASE.md](DATABASE.md) | Tables, database-enforced rules, the audit chain, migrations, seed |
| [DEPLOYMENT.md](DEPLOYMENT.md) | Configuration, processes and jobs, release steps, backups, **known gaps before production**, monitoring |
| [MIGRATION.md](MIGRATION.md) | Moving from V03: data, user-visible changes, V03 programme items |
| [V04_ARCHITECTURE_PLAN.md](V04_ARCHITECTURE_PLAN.md) | The plan, the **owner decision record** (§9a, D-1 … D-41) and implementation notes per commit |
| [reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md](reference/AIGH_Nursing_Workforce_Management_System_v2_8_7.md) | The original specification, verbatim (never edited) |

## Stage-1 analysis (V03)

Produced before V04 was built. They describe V03 and are kept for traceability until the cleanup commit decides their fate; do not use them as a description of V04.

| Document | Contents |
| :--- | :--- |
| [LEGACY_REPOSITORY_INVENTORY.md](LEGACY_REPOSITORY_INVENTORY.md) | What V03 contained |
| [DUPLICATE_IMPLEMENTATION_MAP.md](DUPLICATE_IMPLEMENTATION_MAP.md) | Where V03 implemented the same thing more than once |
| [FEATURE_MASTER_INVENTORY.md](FEATURE_MASTER_INVENTORY.md) | Features and the **business rule register** (R, E, C, D, L, W, S, N, A rule IDs cited throughout) |
| [DATABASE_CONSOLIDATION.md](DATABASE_CONSOLIDATION.md) | How V03's four schema sources became the V04 schema |
| [CLEANUP_PLAN.md](CLEANUP_PLAN.md) | What happens to each V03 file |

## Keeping the documents true

- `npm run docs:check` (also part of `npm test` and CI) fails on any broken link or heading anchor in these documents.
- `backend/test/docs.test.ts` fails if [RBAC.md](RBAC.md) §3 and the permission table in the code differ.
- A new owner decision gets a D-number in the decision record first; the affected documents then cite it.
