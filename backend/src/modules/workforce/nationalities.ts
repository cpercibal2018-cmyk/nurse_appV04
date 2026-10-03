// Nationalities (owner decision 2026-10-03): a fixed, standard list — ISO 3166-1
// alpha-3 codes as on passports — loaded by its migration and read-only in the
// application. Employees store the code; a change to the list comes with a release.

import { z } from 'zod';
import { unprocessable } from '../../lib/http-errors.js';
import type { Db, DbClient } from '../../lib/prisma.js';

/** The request field: a listed code, never free text. */
export const NationalityCode = z.string({ error: 'Nationality is required.' }).trim().toUpperCase()
  .pipe(z.string().regex(/^[A-Z]{3}$/, 'Nationality is required.'));

export async function assertNationality(tx: DbClient, code: string) {
  const n = await tx.nationality.findUnique({ where: { code }, select: { isActive: true } });
  if (!n || !n.isActive) throw unprocessable('NATIONALITY_INVALID', `Not a listed nationality: ${code}`);
  return code;
}

/** Active nationalities, alphabetical by the English name. */
export async function listNationalities(db: Db) {
  const items = await db.nationality.findMany({
    where: { isActive: true }, orderBy: { sortOrder: 'asc' },
    select: { code: true, name: true, nameAr: true, countryName: true },
  });
  return { items };
}
