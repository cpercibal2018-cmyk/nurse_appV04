import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { Paged } from '../../types/api';

export type ContractStatus = 'Draft' | 'PendingApproval' | 'Approved' | 'Active' | 'Expired' | 'Suspended' | 'Terminated' | 'Superseded';
export const CONTRACT_STATUSES: ContractStatus[] = ['Draft', 'PendingApproval', 'Approved', 'Active', 'Expired', 'Suspended', 'Terminated', 'Superseded'];
export type ContractAction = 'submit' | 'return' | 'approve' | 'suspend' | 'reinstate' | 'terminate';

/** Mirrors the server's map (decision D-29) so only possible actions are offered; the server still decides. */
export const TRANSITIONS: Record<ContractAction, ContractStatus[]> = {
  submit: ['Draft'], return: ['PendingApproval'], approve: ['PendingApproval'],
  suspend: ['Approved', 'Active'], reinstate: ['Suspended'], terminate: ['Approved', 'Active'],
};
export const NEEDS_REASON: ContractAction[] = ['return', 'suspend', 'reinstate', 'terminate'];

export interface ContractRow {
  id: number; employeeId: number; jobNumber: string; employeeName: string; positionCode: string; unitCode: string | null;
  status: ContractStatus; startDate: string; endDate: string; startDateHijri: string | null; endDateHijri: string | null;
  view: 'FULL' | 'REDUCED';
  createdById?: number | null; submittedById?: number | null; approvedById?: number | null; approvedAt?: string | null;
}
export interface ContractDoc { id: number; version: number; fileName: string; sizeBytes: number; scanStatus: string; uploadedAt: string }
export interface Renewable {
  employeeId: number; jobNumber: string; fullName: string;
  prior: { id: number; status: ContractStatus; startDate: string; endDate: string; startDateHijri: string | null; endDateHijri: string | null };
  prefill: { start: string; end: string };
}

export const useContracts = (f: { status?: ContractStatus; page: number }, staff: boolean) => useQuery({
  queryKey: ['contracts', staff, f], placeholderData: keepPreviousData,
  queryFn: () => (staff
    ? http.get<Paged<ContractRow>>(`/contracts?page=${f.page}&pageSize=50${f.status ? `&status=${f.status}` : ''}`)
    : http.get<Paged<ContractRow>>('/contracts/me')),
});
/** Employee pickers search on the server (job number or name); `total` counts every match, `items` is the first page. */
const pickerPath = (path: string, q: string) => (q ? `${path}?q=${encodeURIComponent(q)}` : path);
export const useCreatable = (enabled: boolean, q: string) => useQuery({
  queryKey: ['contracts', 'creatable', q], enabled, placeholderData: keepPreviousData,
  queryFn: () => http.get<Paged<{ id: number; jobNumber: string; fullName: string }>>(pickerPath('/contracts/creatable', q)),
});
export const useRenewable = (enabled: boolean, q: string) => useQuery({
  queryKey: ['contracts', 'renewable', q], enabled, placeholderData: keepPreviousData,
  queryFn: () => http.get<Paged<Renewable>>(pickerPath('/contracts/renewable', q)),
});
export const useContractDocs = (id: number | null) => useQuery({ queryKey: ['contracts', 'docs', id], enabled: id !== null, queryFn: () => http.get<Paged<ContractDoc>>(`/contracts/${id}/documents`) });

type Action =
  | { kind: 'create'; body: { employeeId: number; startDate: string; endDate: string }; key: string }
  | { kind: 'renew'; priorId: number; body: { startDate: string; endDate: string }; key: string }
  | { kind: 'transition'; id: number; action: ContractAction; reason?: string }
  | { kind: 'upload'; id: number; file: File };

export function useContractAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case 'create': return http.post('/contracts', a.body, { idempotencyKey: a.key });
        case 'renew': return http.post(`/contracts/${a.priorId}/renew`, a.body, { idempotencyKey: a.key });
        case 'transition': return http.post<{ status: ContractStatus; eligibility: string | null }>(`/contracts/${a.id}/transition`, { action: a.action, ...(a.reason ? { reason: a.reason } : {}) });
        case 'upload': return http.upload(`/contracts/${a.id}/documents`, a.file);
      }
    },
    onSuccess: () => Promise.all(['contracts', 'employees', 'eligibility'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}
