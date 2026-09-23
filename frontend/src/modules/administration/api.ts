import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { AppRole, Paged, ScopeType } from '../../types/api';

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
  payload: { kind: 'GRANT'; grant: GrantInput } | { kind: 'UPDATE'; assignmentId: number; update: { scopeType?: ScopeType; scopeIds?: number[]; reason: string } };
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXECUTED';
  createdAt: string;
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

export const useAccounts = () => useQuery({ queryKey: keys.accounts, queryFn: () => http.get<Paged<Account>>('/users') });
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
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: keys.approvals }), qc.invalidateQueries({ queryKey: keys.assignments })]),
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
