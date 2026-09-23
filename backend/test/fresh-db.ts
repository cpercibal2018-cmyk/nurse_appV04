// A brand-new, empty database for the database-first acceptance tests: created
// next to TEST_DATABASE_URL, migrated with `prisma migrate deploy` (nothing
// else — no seed), and dropped afterwards. The test login needs CREATEDB.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import pg from 'pg';
import { createPrisma, type Db } from '../src/lib/prisma.js';

const BACKEND = resolve(__dirname, '..');

function adminUrl(base: string) {
  const u = new URL(base);
  u.pathname = '/postgres';
  return u.toString();
}

export async function createFreshDatabase(baseUrl: string): Promise<{ url: string; db: Db; drop: () => Promise<void> }> {
  const name = `nurseapp_fresh_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl(baseUrl) });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const u = new URL(baseUrl);
  u.pathname = `/${name}`;
  const url = u.toString();
  // Exactly what a new installation runs.
  execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['prisma', 'migrate', 'deploy'], {
    cwd: BACKEND, env: { ...process.env, DATABASE_URL: url }, stdio: 'pipe', shell: process.platform === 'win32',
  });
  const db = createPrisma(url);

  return {
    url, db,
    drop: async () => {
      await db.$disconnect();
      const c = new pg.Client({ connectionString: adminUrl(baseUrl) });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
