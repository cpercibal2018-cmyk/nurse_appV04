// Nurse-to-bed KPIs (owner decision D-11: kept). Ported from V03
// app/src/lib/kpi.ts, which cites the MoH Ada'a dashboard:
//   A. Nurse to Bed Ratio (Critical Areas) — ICU / ER / OR each coded 1..4, averaged.
//   B. Hospital Nurse to Bed Ratio (hospital-wide, "QFR-55").
//
// THRESHOLD SOURCE: NOT IN REPOSITORY. The cut-lines below are V03's reading of
// the Ada'a indicator card; the card itself was never committed. Every response
// carries `thresholdSource` so the page can say so (D-11). The unit → area map
// is V03's classification of the seeded unit codes; units not listed count
// only towards KPI B.

import { z } from 'zod';
import { isIsoDate, toDbDate } from '../../lib/dates.js';
import type { Db } from '../../lib/prisma.js';

export type Band = 'Standard' | 'Distress' | 'Failing' | 'Failed';
export type CriticalArea = 'ICU' | 'ER' | 'OR';

export const THRESHOLD_SOURCE = 'V03 reading of the MoH Ada\'a indicator card — the card is not in the repository; verify before relying on the bands (D-11)';

export const CRITICAL_AREA_BY_UNIT_CODE: Readonly<Record<string, CriticalArea>> = {
  ICU_MAIN: 'ICU', ICU_EXT: 'ICU', NICU: 'ICU', PICU: 'ICU', CCU: 'ICU', BURN_ICU: 'ICU',
  ER_MAIN: 'ER', ER_MC: 'ER', UCC: 'ER', CDU: 'ER',
  OR: 'OR',
};

const round1 = (n: number) => Math.round(n * 10) / 10;

function codeToBand(code: number): Band {
  if (code <= 1.5) return 'Standard';
  if (code <= 2.5) return 'Distress';
  if (code <= 3.5) return 'Failing';
  return 'Failed';
}

// ICU/ER: beds per nurse (lower is better). OR: nurses per bed (higher is better).
function codeIcu(bpn: number): 1 | 2 | 3 | 4 { return bpn <= 1.5 ? 1 : bpn <= 2.5 ? 2 : bpn <= 3.5 ? 3 : 4; }
function codeEr(bpn: number): 1 | 2 | 3 | 4 { return bpn <= 2.5 ? 1 : bpn <= 3.5 ? 2 : bpn <= 4.5 ? 3 : 4; }
function codeOr(npb: number): 1 | 2 | 3 | 4 { return npb >= 1.5 ? 1 : npb >= 0.75 ? 2 : npb >= 0.417 ? 3 : 4; }

export interface AreaResult { area: CriticalArea; nurses: number; beds: number; code: 1 | 2 | 3 | 4; band: Band; ratioLabel: string }

export function scoreArea(area: CriticalArea, nurses: number, beds: number): AreaResult {
  const bpn = nurses > 0 ? beds / nurses : Infinity;
  const npb = beds > 0 ? nurses / beds : 0;
  const code = area === 'ICU' ? codeIcu(bpn) : area === 'ER' ? codeEr(bpn) : codeOr(npb);
  let ratioLabel = '—';
  if (nurses > 0 && beds > 0) ratioLabel = area === 'OR' && npb >= 1 ? `${round1(npb)}:1` : `1:${round1(bpn)}`;
  return { area, nurses, beds, code, band: codeToBand(code), ratioLabel };
}

export function computeKpiA(input: Record<CriticalArea, { nurses: number; beds: number }>) {
  const areas = (['ICU', 'ER', 'OR'] as const).map((a) => scoreArea(a, input[a].nurses, input[a].beds));
  const averageCode = areas.reduce((s, a) => s + a.code, 0) / areas.length;
  return { areas, averageCode: round1(averageCode), band: codeToBand(averageCode) };
}

/** Standard 1:<6 · Distress 1:6–<7 · Failing 1:7–9 · Failed 1:>9. */
export function computeKpiB(nurses: number, beds: number) {
  const bpn = nurses > 0 ? beds / nurses : Infinity;
  const band: Band = bpn < 6 ? 'Standard' : bpn < 7 ? 'Distress' : bpn <= 9 ? 'Failing' : 'Failed';
  return { nurses, beds, band, ratioLabel: nurses > 0 ? `1:${round1(bpn)}` : '—' };
}

export const KpiQuery = z.object({
  date: z.string().refine(isIsoDate, 'YYYY-MM-DD'),
  shift: z.enum(['Morning', 'Evening', 'Night']),
});

/** Nurses = Published assignments on that date and shift (V03 definition); beds = active units. */
export async function nurseToBed(db: Db, q: z.infer<typeof KpiQuery>) {
  const [units, assignments] = await Promise.all([
    db.unit.findMany({ where: { isActive: true }, select: { id: true, code: true, bedCount: true } }),
    db.shiftAssignment.groupBy({ by: ['unitId'], where: { shiftDate: toDbDate(q.date), shiftType: q.shift, status: 'Published' }, _count: { _all: true } }),
  ]);
  const onDuty = new Map(assignments.map((a) => [a.unitId, a._count._all]));
  const areas: Record<CriticalArea, { nurses: number; beds: number }> = { ICU: { nurses: 0, beds: 0 }, ER: { nurses: 0, beds: 0 }, OR: { nurses: 0, beds: 0 } };
  for (const u of units) {
    const area = CRITICAL_AREA_BY_UNIT_CODE[u.code];
    if (area) { areas[area].beds += u.bedCount; areas[area].nurses += onDuty.get(u.id) ?? 0; }
  }
  const beds = units.reduce((s, u) => s + u.bedCount, 0);
  const nurses = units.reduce((s, u) => s + (onDuty.get(u.id) ?? 0), 0);
  return {
    date: q.date, shift: q.shift,
    kpiA: computeKpiA(areas), kpiB: computeKpiB(nurses, beds),
    areaUnits: CRITICAL_AREA_BY_UNIT_CODE,
    thresholdSource: THRESHOLD_SOURCE,
  };
}
