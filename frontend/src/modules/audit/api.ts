import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';

export interface AuditRow {
  id: string; actorUserId: number | null; actorName: string | null; action: string; resource: string; resourceId: string | null;
  changes: Record<string, unknown>; requestId: string | null; priority: 'NORMAL' | 'HIGH'; createdAt: string;
}
export interface AuditFilter { action?: string; resource?: string; resourceId?: string; priority?: 'NORMAL' | 'HIGH'; from?: string; to?: string; page: number }
export interface JobRun { id: number; runKey: string; status: 'RUNNING' | 'COMPLETED' | 'FAILED'; startedAt: string; finishedAt: string | null; attempts: number; summary: Record<string, unknown> | null; error: string | null }

export const useAudit = (f: AuditFilter) => useQuery({
  queryKey: ['audit', f],
  queryFn: () => {
    const p = new URLSearchParams({ page: String(f.page), pageSize: '50' });
    for (const k of ['action', 'resource', 'resourceId', 'priority', 'from', 'to'] as const) if (f[k]) p.set(k, f[k]!);
    return http.get<{ items: AuditRow[]; total: number }>(`/audit?${p}`);
  },
});
/** Spec §9.2: one row per API request (no bodies, no query strings). */
export interface RequestLogRow {
  id: string; requestId: string; at: string; actorUserId: number | null; actorName: string | null; actorRoles: string | null;
  sessionFamily: string | null; method: string; path: string; statusCode: number; durationMs: number;
  ipAddress: string | null; userAgent: string | null; paramsHash: string | null; errorCode: string | null;
}
export interface RequestLogFilter { actor?: number; requestId?: string; method?: string; status?: string; path?: string; errorCode?: string; from?: string; to?: string; page: number }
export const useRequestLog = (f: RequestLogFilter) => useQuery({
  queryKey: ['audit', 'requests', f],
  placeholderData: keepPreviousData,
  queryFn: () => {
    const p = new URLSearchParams({ page: String(f.page), pageSize: '50' });
    for (const k of ['requestId', 'method', 'status', 'path', 'errorCode', 'from', 'to'] as const) if (f[k]) p.set(k, f[k]!);
    if (f.actor) p.set('actor', String(f.actor));
    return http.get<{ items: RequestLogRow[]; total: number }>(`/audit/requests?${p}`);
  },
});
export const useVerify = () => useMutation({ mutationFn: () => http.get<{ intact: boolean; breaks: Array<{ id: string; reason: string }>; checkedAt: string }>('/audit/verify') });
export const useJobs = () => useQuery({ queryKey: ['jobs'], queryFn: () => http.get<{ items: Array<{ name: string; schedule: string; runs: JobRun[] }> }>('/admin/jobs') });
export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => http.post<{ status: string; summary?: Record<string, unknown>; error?: string }>(`/admin/jobs/${name}/run`), onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }) });
}

export interface SessionRow { current: boolean; active: boolean; signedInAt: string; lastActiveAt: string; endsBy: string; signInIp: string | null; signInUserAgent: string | null; lastIp: string | null; lastUserAgent: string | null }
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => http.get<{ items: SessionRow[] }>('/auth/sessions') });

// ── Business health (spec §10.8), System Admin ──
export interface BusinessHealth {
  status: 'HEALTHY' | 'ATTENTION';
  issues: Array<{ code: string; message: string }>;
  eligibility: {
    lastAuditAt: string | null; lastChecked: number | null; lastDrifted: number | null;
    checked7d: number; drifts7d: number; driftRate7d: number | null;
    recentDrifts: Array<{ employeeId: number; jobNumber: string; expected: string; stored: string | null; detectedAt: string }>;
  };
  jobs: Array<{ name: string; lastCompletedAt: string | null; ageMinutes: number | null; stale: boolean; lastAttemptFailed: boolean }>;
  email: { pendingOver15Minutes: number; failedLast24Hours: number; lastSentAt: string | null };
  generatedAt: string;
}
export const useBusinessHealth = () => useQuery({ queryKey: ['business-health'], queryFn: () => http.get<BusinessHealth>('/system/health/business'), refetchInterval: 60_000 });
