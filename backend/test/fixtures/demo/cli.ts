// npm run fixtures:demo -w backend [-- --allow-database=<name>]
//
// Development and demonstration only. Loads the demo accounts, the hospital
// baseline and the fictional workforce into an EMPTY database whose name is
// marked _dev, _test or _demo (or explicitly allowed). Refuses production.
// The demo password comes from DEMO_PASSWORD (12–72 characters); none is stored.

import 'dotenv/config';
import { createPasswordService } from '../../../src/lib/passwords.js';
import { createPrisma } from '../../../src/lib/prisma.js';
import { assertFixtureTarget, loadDemoFixtures } from './load.js';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const allow = process.argv.find((a) => a.startsWith('--allow-database='))?.split('=')[1];
  const name = assertFixtureTarget(process.env, url, allow);
  const password = process.env.DEMO_PASSWORD;
  if (!password) throw new Error('Set DEMO_PASSWORD (12–72 characters) for the demo accounts.');
  const db = createPrisma(url);
  try {
    const out = await loadDemoFixtures(db, password, createPasswordService(Number(process.env.BCRYPT_ROUNDS ?? 12)));
    console.log(`Demo fixtures loaded into ${name}: ${out.users} accounts, ${out.employees} employees, hospital baseline imported.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
