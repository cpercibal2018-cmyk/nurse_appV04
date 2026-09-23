import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { Paged } from '../../types/api';

/** HR and own profile get every field; a Supervisor gets the baseline (§8.1, D-36). */
export interface EmployeeRow {
  id: number; jobNumber: string; firstName: string; middleName: string | null; lastName: string; fullName: string;
  jobTitle: string | null; specialty: string | null; unitId: number | null; unit: { code: string; name: string } | null;
  positionCode: string; position: { code: string; title: string }; status: string; hireDate: string | null;
  view: 'FULL' | 'BASELINE';
  contactEmail: string; primaryPhone: string | null; actualWorkPlace: string | null;
  fileNo?: string | null; rankGrade?: string | null; nationality?: string | null; jobPostLocation?: string | null; emergencyContactPhone?: string | null;
  maritalStatus?: 'Single' | 'Married' | 'Others' | null; salary?: string | null;
}

export interface EmployeeFilter { q?: string; unitId?: number; page: number }

export const useEmployees = (f: EmployeeFilter) => useQuery({
  queryKey: ['employees', f], placeholderData: keepPreviousData,
  queryFn: () => {
    const p = new URLSearchParams({ page: String(f.page), pageSize: '50' });
    if (f.q) p.set('q', f.q);
    if (f.unitId) p.set('unitId', String(f.unitId));
    return http.get<Paged<EmployeeRow>>(`/employees?${p}`);
  },
});
export const useMyEmployee = () => useQuery({ queryKey: ['employees', 'me'], queryFn: () => http.get<EmployeeRow>('/employees/me'), retry: false });

/** D-35: the employee's own phone numbers — the only fields they maintain. */
export function useUpdateOwnContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { primaryPhone?: string | null; emergencyContactPhone?: string | null }) => http.patch<EmployeeRow>('/employees/me/contact', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['employees'] }),
  });
}

export const useEmployee = (id: number | null) => useQuery({ queryKey: ['employees', 'one', id], enabled: id !== null, queryFn: () => http.get<EmployeeRow>(`/employees/${id}`) });

type Action =
  | { kind: 'onboard'; body: object; key: string }
  | { kind: 'update'; id: number; body: object }
  | { kind: 'position'; id: number; positionCode: string; reason: string }
  | { kind: 'delete'; id: number; reason: string };

export function useEmployeeAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a: Action): Promise<unknown> => {
      switch (a.kind) {
        case 'onboard': return http.post<{ employeeId: number; contractId: number }>('/employees/onboard', a.body, { idempotencyKey: a.key });
        case 'update': return http.patch(`/employees/${a.id}`, a.body);
        case 'position': return http.post(`/employees/${a.id}/position`, { positionCode: a.positionCode, reason: a.reason });
        case 'delete': return http.delete(`/employees/${a.id}`, { reason: a.reason });
      }
    },
    onSuccess: () => Promise.all(['employees', 'contracts', 'eligibility'].map((k) => qc.invalidateQueries({ queryKey: [k] }))),
  });
}
