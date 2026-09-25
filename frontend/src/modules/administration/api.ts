import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { AppRole, DataSubjectRequest, DsrType, Paged, ScopeType } from '../../types/api';

export interface Account {
  id: number;
  email: string;
  displayName: string;
  isActive: boolean;
  isBreakGlass: boolean;
  employeeId: number | null;
  lastLoginAt: string | null;
  employee: { jobNumber: string; fullName: string; unitId: number | null } | null;
  roleAssignments: Array<{ role: AppRole; scopeType: ScopeType }>;
  /** An authenticator is set up (spec §3.5). */
  mfaEnabled: boolean;
}

export interface Assignment {
  id: number;
  userId: number;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  reason: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
  approvalRequestId: number | null;
  active: boolean;
  user: { email: string; displayName: string };
  grantedBy: { displayName: string };
}

export interface ApprovalRequest {
  id: number;
  actionType: string;
  payload:
    | { kind: 'GRANT'; grant: GrantInput }
    | { kind: 'UPDATE'; assignmentId: number; update: { scopeType?: ScopeType; scopeIds?: number[]; reason: string } }
    | { kind: 'TEMPLATE_CREATE'; template: { code: string; name: string }; reason: string }
    | { kind: 'TEMPLATE_UPDATE'; templateId: number; code: string; change: Record<string, unknown>; before: Record<string, unknown>; reason: string }
    | { kind: 'CATEGORY_CREATE'; category: { code: string; name: string }; reason: string }
    | { kind: 'CATEGORY_UPDATE'; code: string; change: Record<string, unknown>; before: Record<string, unknown>; reason: string }
    | { kind: 'BASELINE_IMPORT'; fileHash: string; totals: BaselineReport['totals']; reason: string };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED' | 'WITHDRAWN';
  createdAt: string;
  initiatorId: number;
  initiator: { displayName: string; email: string };
  approver: { displayName: string } | null;
  reason: string | null;
}

export interface GrantInput {
  userId: number;
  role: AppRole;
  scopeType: ScopeType;
  scopeIds: number[];
  reason: string;
  expiresAt?: string;
}

export type GrantOutcome = { status: 'GRANTED'; id: number } | { status: 'PENDING_APPROVAL'; requestId: number };

export interface Department { id: number; code: string; name: string }
export interface Unit { id: number; code: string; name: string; departmentId: number }

export interface Matrix {
  matrix: { columns: string[]; rows: Array<{ area: string; cells: string[] }>; source: string };
  permissions: Record<string, string[]>;
}

const keys = {
  accounts: ['accounts'] as const,
  assignments: ['role-assignments'] as const,
  approvals: ['approvals'] as const,
  pam: ['pam'] as const,
};

/** Accounts, optionally filtered on the server by e-mail or display name. */
export const useAccounts = (q = '') => useQuery({
  queryKey: [...keys.accounts, q], placeholderData: keepPreviousData,
  queryFn: () => http.get<Paged<Account>>(q ? `/users?q=${encodeURIComponent(q)}` : '/users'),
});
export const useAssignments = () => useQuery({ queryKey: keys.assignments, queryFn: () => http.get<Paged<Assignment>>('/role-assignments') });
export const useApprovals = () => useQuery({ queryKey: keys.approvals, queryFn: () => http.get<Paged<ApprovalRequest>>('/approvals?status=PENDING') });
export const usePamStatus = () => useQuery({ queryKey: keys.pam, queryFn: () => http.get<{ eligible: boolean; active: boolean; expiresAt: string | null }>('/pam/status') });
export const useMatrix = () => useQuery({ queryKey: ['matrix'], queryFn: () => http.get<Matrix>('/roles/matrix'), staleTime: Infinity });
export const useDepartments = () => useQuery({ queryKey: ['departments'], queryFn: () => http.get<Paged<Department>>('/departments') });
export const useUnits = () => useQuery({ queryKey: ['units'], queryFn: () => http.get<Paged<Unit>>('/units') });

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: { email: string; displayName: string; password: string; employeeId?: number | null }; key: string }) =>
      http.post<{ id: number }>('/users', body, { idempotencyKey: key }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { isActive?: boolean; displayName?: string } }) => http.patch(`/users/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.accounts }),
  });
}

export function useGrant() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, key }: { body: GrantInput; key: string }) => http.post<GrantOutcome>('/role-assignments', body, { idempotencyKey: key }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.assignments }), qc.invalidateQueries({ queryKey: keys.approvals }), qc.invalidateQueries({ queryKey: keys.accounts })]),
  });
}

export function useRevoke() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) => http.post(`/role-assignments/${id}/revoke`, { reason }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.assignments }), qc.invalidateQueries({ queryKey: keys.accounts })]),
  });
}

export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: number; decision: 'approve' | 'reject'; reason: string }) =>
      http.post<{ id: number; status: string }>(`/approvals/${id}/${decision}`, { reason }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.approvals }), qc.invalidateQueries({ queryKey: keys.assignments }), qc.invalidateQueries({ queryKey: ['templates'] })]),
  });
}

export function useWithdraw() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      http.post<{ id: number; status: 'WITHDRAWN' }>(`/approvals/${id}/withdraw`, { reason }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.approvals }),
  });
}

export function usePamActions() {
  const qc = useQueryClient();
  const done = () => qc.invalidateQueries();
  return {
    elevate: useMutation({ mutationFn: (body: { reason: string; durationHours: number }) => http.post('/pam/elevate', body), onSuccess: done }),
    end: useMutation({ mutationFn: () => http.post('/pam/end'), onSuccess: done }),
  };
}

// ── Hospital baseline import (P7) ─────────────────────────────────────────────
export interface BaselineRow { section: string; code: string; status: 'CREATE' | 'UNCHANGED' | 'CONFLICT' | 'REJECTED'; issues: string[] }
export interface BaselineReport {
  fileHash: string;
  counts: Record<string, Record<BaselineRow['status'], number>>;
  totals: Record<BaselineRow['status'], number> & { beds: number; fields: number };
  rows: BaselineRow[];
  canImport: boolean;
}

export const useBaselinePreview = () => useMutation({
  mutationFn: (file: unknown) => http.post<BaselineReport>('/admin/baseline-import/preview', { file }),
});

export function useBaselineRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { file: unknown; reason: string }) =>
      http.post<{ status: 'PENDING_APPROVAL'; requestId: number } | { status: 'APPLIED' }>('/admin/baseline-import', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['approvals'] }),
  });
}

/** Spec §8.3.2 (D-54): the lawful basis per category of sensitive data. */
export interface RegisterEntry {
  id: number; dataCategory: 'IQAMA' | 'PASSPORT' | 'SCFHS_REG' | 'IDENTITY_SCAN';
  lawfulBasis: 'EMPLOYMENT_CONTRACT' | 'LEGAL_OBLIGATION' | 'CONSENT' | 'VITAL_INTEREST' | 'PUBLIC_INTEREST';
  purpose: string; retentionRule: string; isActive: boolean; updatedAt: string;
}
export interface RegisterSignOff {
  last: { id: number; reviewedBy: { id: number; displayName: string }; title: string; note: string | null; reviewedAt: string } | null;
  changedSince: boolean; dueAt: string | null; due: boolean;
}
export const useProcessingRegister = () => useQuery({ queryKey: ['pdpl', 'register'], queryFn: () => http.get<{ items: RegisterEntry[]; signOff: RegisterSignOff }>('/pdpl/register') });
/** B-18 (D-56): the Data Protection Officer signs off the register as it stands. */
export function useSignOffRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { title: string; note?: string; confirm: true }) => http.post<{ id: number }>('/pdpl/register/sign-offs', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl'] }),
  });
}
export function useUpdateRegister() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: number; body: { purpose?: string; retentionRule?: string; isActive?: boolean; reason: string } }) => http.patch<RegisterEntry>(`/pdpl/register/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl'] }),
  });
}

// Data-subject requests (spec §8.3.3, D-55).
export interface DsrFilter { open?: boolean; type?: DsrType }
export const useDataSubjectRequests = (f: DsrFilter) => useQuery({
  queryKey: ['pdpl', 'requests', f],
  queryFn: () => {
    const p = new URLSearchParams();
    if (f.open) p.set('open', 'true');
    if (f.type) p.set('type', f.type);
    return http.get<{ items: DataSubjectRequest[] }>(`/pdpl/requests?${p}`);
  },
});
export type DsrAction =
  | { kind: 'log'; body: { employeeId: number; type: DsrType; details?: string } }
  | { kind: 'review' | 'approve'; id: number; note?: string }
  | { kind: 'reject' | 'complete'; id: number; note: string }
  | { kind: 'erase'; id: number; note: string; confirmJobNumber: string };
export function useDsrAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: DsrAction) => {
      switch (a.kind) {
        case 'log': return http.post<DataSubjectRequest>('/pdpl/requests', a.body);
        case 'review': return http.post<DataSubjectRequest>(`/pdpl/requests/${a.id}/review`);
        case 'erase': return http.post<DataSubjectRequest>(`/pdpl/requests/${a.id}/erase`, { note: a.note, confirmJobNumber: a.confirmJobNumber });
        default: return http.post<DataSubjectRequest>(`/pdpl/requests/${a.id}/${a.kind}`, a.note ? { note: a.note } : {});
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['pdpl'] }),
  });
}
