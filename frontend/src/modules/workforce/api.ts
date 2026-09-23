import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { Paged } from '../../types/api';

export type ShiftType = 'Morning' | 'Evening' | 'Night';
export const SHIFTS: ShiftType[] = ['Morning', 'Evening', 'Night'];

export interface DepartmentRow { id: number; code: string; name: string; nameAr: string | null; description: string | null; isActive: boolean }
export type CriticalArea = 'ICU' | 'ER' | 'OR';
export interface UnitRow { id: number; code: string; name: string; nameAr: string | null; description: string | null; departmentId: number; bedCount: number; criticalArea: CriticalArea | null; isActive: boolean }
export interface PositionRow { code: string; title: string; titleAr: string | null; tier: string; description: string | null; isSchedulable: boolean; isActive: boolean; displayOrder: number; replacedBy: string | null }
export interface CoverageTarget { id: number; unitId: number; shiftType: ShiftType; minimumStaff: number }
export interface BedLog { id: number; previousCount: number; newCount: number; reason: string; changedAt: string; changedBy: string | null }
export interface Summary { unitCount: number; totalBeds: number; byDepartment: Array<{ id: number; code: string; name: string; units: number; beds: number }> }
export interface ImportResult {
  dryRun: boolean; created: number; updated: number; unchanged: number; rejected: number;
  results: Array<{ line: number; unitCode: string; status: 'CREATED' | 'UPDATED' | 'UNCHANGED' | 'REJECTED'; reason?: string }>;
}
export type Band = 'Standard' | 'Distress' | 'Failing' | 'Failed';
export interface Kpi {
  date: string; shift: ShiftType; thresholdSource: string; areaUnits: Record<string, string>;
  kpiA: { averageCode: number; band: Band; areas: Array<{ area: string; nurses: number; beds: number; code: number; band: Band; ratioLabel: string }> };
  kpiB: { nurses: number; beds: number; band: Band; ratioLabel: string };
}

export const TIERS = ['Executive', 'Administrative', 'Management', 'Specialist', 'Advanced Practice', 'Clinical Lead', 'Clinical', 'Clinical Specialist', 'Support'];

export const useAllDepartments = () => useQuery({ queryKey: ['departments', 'all'], queryFn: () => http.get<Paged<DepartmentRow>>('/departments?includeInactive=true') });
export const useAllUnits = () => useQuery({ queryKey: ['units', 'all'], queryFn: () => http.get<Paged<UnitRow>>('/units?includeInactive=true') });
export const usePositions = (includeInactive = false) => useQuery({ queryKey: ['positions', includeInactive], queryFn: () => http.get<Paged<PositionRow>>(`/positions${includeInactive ? '?includeInactive=true' : ''}`) });
export const useSummary = () => useQuery({ queryKey: ['units', 'summary'], queryFn: () => http.get<Summary>('/units/summary') });
export const useCoverage = () => useQuery({ queryKey: ['coverage'], queryFn: () => http.get<Paged<CoverageTarget>>('/coverage-targets') });
export const useBedHistory = (unitId: number | null) => useQuery({
  queryKey: ['bed-history', unitId], enabled: unitId !== null, queryFn: () => http.get<Paged<BedLog>>(`/units/${unitId}/bed-history`),
});
export const useKpi = (date: string, shift: ShiftType) => useQuery({ queryKey: ['kpi', date, shift], queryFn: () => http.get<Kpi>(`/kpi/nurse-to-bed?date=${date}&shift=${shift}`) });

type Action =
  | { kind: 'department'; id?: number; body: object }
  | { kind: 'unit'; id?: number; body: object }
  | { kind: 'beds'; id: number; bedCount: number; reason: string }
  | { kind: 'import'; csv: string; dryRun: boolean }
  | { kind: 'position'; code?: string; body: object }
  | { kind: 'coverage'; unitId: number; shiftType: ShiftType; minimumStaff: number | null };

export function useWorkforceAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case 'department': return a.id ? http.patch(`/departments/${a.id}`, a.body) : http.post('/departments', a.body);
        case 'unit': return a.id ? http.patch(`/units/${a.id}`, a.body) : http.post('/units', a.body);
        case 'beds': return http.put(`/units/${a.id}/bed-capacity`, { bedCount: a.bedCount, reason: a.reason });
        case 'import': return http.post<ImportResult>('/units/import', { csv: a.csv, dryRun: a.dryRun }, { idempotencyKey: crypto.randomUUID() });
        case 'position': return a.code ? http.patch(`/positions/${a.code}`, a.body) : http.post('/positions', a.body);
        case 'coverage': return http.put('/coverage-targets', { unitId: a.unitId, shiftType: a.shiftType, minimumStaff: a.minimumStaff });
      }
    },
    onSuccess: () => Promise.all(['departments', 'units', 'positions', 'coverage', 'bed-history', 'eligibility'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}
