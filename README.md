# AIGH Nursing Workforce Management System — V04

Clean rebuild of `nurse_appV03`: one backend, one frontend, one schema, one API.

| Path | What it is |
| :--- | :--- |
| `backend/` | Express 5 + TypeScript + Prisma + PostgreSQL — the only API, where every business rule is enforced |
| `frontend/` | React 19 + Vite + TypeScript + antd — the only UI |
| `ops/backup/` | PostgreSQL WAL archiving, encrypted base backup, PITR restore and drill scripts |
| `docs/` | Documentation. Start with `docs/V04_ARCHITECTURE_PLAN.md`; the original specification is in `docs/reference/` |

## Requirements

Node.js 22 LTS or newer, PostgreSQL 15 (or `docker compose up -d db`).

## Getting started

```bash
npm install
cp .env.example backend/.env
npm run dev:backend      # http://localhost:3001/api/v1/health
npm run dev:frontend     # http://localhost:5173
```

## Checks

```bash
npm run typecheck
npm test
npm run build            # includes the frontend bundle budget gate
```

## Status

Stage 2 of the consolidation is in progress; see the commit sequence in `docs/V04_ARCHITECTURE_PLAN.md` §7.
