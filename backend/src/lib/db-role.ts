// Database role start-up check (spec §10.7; ops/db/README.md).
//
// In production the API and worker must connect as nurseapp_runtime: data
// access only. This refuses to start when DATABASE_URL instead connects as a
// login that can change the schema or rewrite audit history — a superuser, the
// owner of the tables (or a member of the owning role), or anyone still holding
// UPDATE on audit_entries — which is what happens when the roles were never
// applied or the URL was not switched. Checked by capability, not by role name.

import type { Db } from './prisma.js';

interface RoleFacts {
  user: string;
  superuser: boolean;
  createRole: boolean;
  createSchema: boolean;
  ownsTables: boolean | null;
  auditUpdate: boolean | null;
}

export class DatabaseRoleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseRoleError';
  }
}

/** Problems with the connected login, empty when it is a data-only role. */
export async function runtimeRoleProblems(db: Db): Promise<string[]> {
  const [f] = await db.$queryRaw<RoleFacts[]>`
    SELECT current_user::text AS "user",
           r.rolsuper AS superuser,
           r.rolcreaterole AS "createRole",
           has_schema_privilege('public', 'CREATE') AS "createSchema",
           pg_has_role(current_user, (SELECT relowner FROM pg_class WHERE oid = to_regclass('public.audit_entries')), 'MEMBER') AS "ownsTables",
           has_table_privilege(to_regclass('public.audit_entries'), 'UPDATE') AS "auditUpdate"
      FROM pg_roles r WHERE r.rolname = current_user`;
  const problems: string[] = [];
  if (f!.superuser) problems.push('is a superuser');
  if (f!.createRole) problems.push('can create roles');
  if (f!.ownsTables) problems.push('owns the tables (can alter or drop them)');
  if (f!.createSchema) problems.push('can create objects in schema public');
  if (f!.auditUpdate) problems.push('can rewrite audit_entries');
  return problems.map((p) => `"${f!.user}" ${p}`);
}

export async function assertRuntimeRole(db: Db, isProduction: boolean) {
  if (!isProduction) return;
  const problems = await runtimeRoleProblems(db);
  if (problems.length > 0) {
    throw new DatabaseRoleError(
      `DATABASE_URL must connect as the data-only runtime role in production (spec §10.7): ${problems.join('; ')}. ` +
      'Apply ops/db (README.md), run ops/db/verify.sql, then point DATABASE_URL at nurseapp_runtime.',
    );
  }
}
