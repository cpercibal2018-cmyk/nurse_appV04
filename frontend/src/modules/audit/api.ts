import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
export const useVerify = () => useMutation({ mutationFn: () => http.get<{ intact: boolean; breaks: Array<{ id: string; reason: string }>; checkedAt: string }>('/audit/verify') });
export const useJobs = () => useQuery({ queryKey: ['jobs'], queryFn: () => http.get<{ items: Array<{ name: string; schedule: string; runs: JobRun[] }> }>('/admin/jobs') });
export function useRunJob() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (name: string) => http.post<{ status: string; summary?: Record<string, unknown>; error?: string }>(`/admin/jobs/${name}/run`), onSuccess: () => qc.invalidateQueries({ queryKey: ['jobs'] }) });
}

export interface SessionRow { current: boolean; active: boolean; signedInAt: string; lastActiveAt: string; endsBy: string; signInIp: string | null; signInUserAgent: string | null; lastIp: string | null; lastUserAgent: string | null }
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => http.get<{ items: SessionRow[] }>('/auth/sessions') });
