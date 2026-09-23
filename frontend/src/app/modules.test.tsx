// The page registry drives both the router and the menu (Phase 15 "routes").
import { describe, expect, it } from 'vitest';
import { MODULES } from './modules';

describe('page registry', () => {
  it('has unique paths and labels, and only real roles in its access hints', () => {
    expect(new Set(MODULES.map((m) => m.path)).size).toBe(MODULES.length);
    expect(new Set(MODULES.map((m) => m.labelKey)).size).toBe(MODULES.length);
    const roles = new Set(['SYSTEM_ADMIN', 'HR_ADMIN', 'SUPERVISOR']);
    for (const m of MODULES) for (const r of m.requires ?? []) expect(roles.has(r)).toBe(true);
  });

  it('keeps the audit trail to System Admins (D-20) and staff pages to staff', () => {
    const find = (p: string) => MODULES.find((m) => m.path === p)!;
    expect(find('/audit').requires).toEqual(['SYSTEM_ADMIN']);
    for (const p of ['/nurses', '/credentials', '/eligibility', '/kpi']) expect(find(p).requires).toEqual(['HR_ADMIN', 'SYSTEM_ADMIN', 'SUPERVISOR']);
    expect(find('/my-credentials').employeeOnly).toBe(true);
  });

  it('every page module can be loaded', async () => {
    for (const m of MODULES) expect(typeof (await m.load()).default).toBe('function');
  }, 60_000);
});
