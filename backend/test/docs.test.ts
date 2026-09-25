// docs/RBAC.md §3 is the readable copy of the permission table; it must never
// drift from the code that enforces it (backend/src/modules/users/permissions.ts).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS } from '../src/modules/users/permissions.js';

const rbac = readFileSync(join(__dirname, '..', '..', 'docs', 'RBAC.md'), 'utf8');

describe('docs/RBAC.md', () => {
  it('lists exactly the permissions and roles of permissions.ts', () => {
    // "—": a permission no role holds (D-65: only another system, through its API-client scope).
    const rows = [...rbac.matchAll(/^\| `([\w.]+)` \| ([A-Z_, ]+|—) \|/gm)].map((m) => [m[1]!, m[2] === '—' ? [] : m[2]!.split(',').map((r) => r.trim()).sort()] as const);
    const documented = Object.fromEntries(rows);
    expect(rows.length, 'a permission is listed twice').toBe(Object.keys(documented).length);
    const code = Object.fromEntries(Object.entries(PERMISSIONS).map(([p, roles]) => [p, [...roles].sort()]));
    expect(documented).toEqual(code);
  });
});
