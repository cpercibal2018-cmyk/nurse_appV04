import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { http } from '../../services/http';
import type { Paged } from '../../types/api';

export type CredentialStatus = 'PendingVerification' | 'Valid' | 'ExpiringSoon' | 'Expired' | 'Suspended' | 'Revoked';
export type Lifecycle = 'Active' | 'SubjectToRenew' | 'OnProcess' | 'Expired';
export type EligibilityStatus = 'ELIGIBLE' | 'ELIGIBLE_WITH_GRACE' | 'ELIGIBLE_WITH_POLICY_WARNING' | 'INELIGIBLE';

/** D-54: sensitive personal data (spec §8.3.1) — encrypted per employee and searchable only by exact number. */
export const PDPL_CATEGORIES = ['IQAMA', 'PASSPORT', 'SCFHS_REG'] as const;
export type PdplCategory = (typeof PDPL_CATEGORIES)[number];
export interface FieldDef { key: string; label: string; type: (typeof FIELD_TYPES)[number]; required: boolean; displayOrder: number; isIssueDate?: boolean; isExpiryDate?: boolean; pdplCategory?: PdplCategory }
export interface Template { id: number; code: string; name: string; categoryCode: string; description: string | null; hasExpiry: boolean; requiresUpload: boolean; gracePeriodDays: number; displayOrder: number; isActive: boolean; fieldDefs: FieldDef[] }
/** The field types the server accepts (catalog.ts `FieldType`). */
export const FIELD_TYPES = ['text', 'date', 'date_hijri', 'select', 'number', 'country', 'reference'] as const;
export interface Requirement {
  id: number; templateId: number; unitId: number; positionCode: string | null;
  policyStatus: 'MANDATORY' | 'TRANSITION' | 'OPTIONAL'; transitionDeadline: string | null;
  template: { code: string; name: string }; unit: { code: string; name: string };
}
export interface CredentialRow {
  id: number; employeeId: number; employee: { fullName: string; jobNumber: string; unitId: number | null };
  templateId: number; template: { code: string; name: string };
  status: CredentialStatus; lifecycle: Lifecycle; issueDate: string | null; expiryDate: string | null; expiryDateHijri: string | null; graceExpiryDate: string | null;
  // Present for the owner and HR only (supervisors get the compliance view).
  trackingData?: Record<string, string | number>; pendingData?: { issueDate: string | null; expiryDate: string | null } | null;
  statusReason?: string | null; documentsPendingReview?: number;
  /** D-54: the employee's sensitive values were erased (§8.3.3); they read as null. */
  personalDataErased?: boolean;
}
export interface DocumentRow { id: number; version: number; fileName: string; mimeType: string; sizeBytes: number; scanStatus: string; reviewStatus: string; uploadedAt: string; isCurrentEvidence: boolean }
export interface Reason { code: string; severity: 'BLOCK' | 'WARN' | 'INFO'; message: string; templateCode?: string; until?: string }
export interface StateRow {
  employeeId: number; status: EligibilityStatus; reasons: Reason[]; calculatedAt: string; updatedByEvent: string | null;
  employee: { id: number; jobNumber: string; fullName: string; unitId: number | null; positionCode: string };
}
export interface Waiver {
  id: number; employeeId: number; templateId: number; reason: string; createdAt: string; expiresAt: string; active: boolean;
  template: { code: string; name: string }; employee: { jobNumber: string; fullName: string };
}

const invalidateAll = (qc: ReturnType<typeof useQueryClient>) =>
  Promise.all(['credentials', 'my-credentials', 'eligibility', 'requirements', 'documents', 'waivers', 'templates'].map((k) => qc.invalidateQueries({ queryKey: [k] })));

export interface Category { code: string; name: string; description: string | null; displayOrder: number }
export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => http.get<{ items: Category[] }>('/credential-categories') });
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: () => http.get<{ items: Template[] }>('/credential-templates?includeInactive=true') });
export const useRequirements = () => useQuery({ queryKey: ['requirements'], queryFn: () => http.get<Paged<Requirement>>('/credential-requirements') });
export const useCredentials = (queue?: 'review', identifier?: string) => useQuery({
  queryKey: ['credentials', queue ?? 'all', identifier ?? ''],
  queryFn: () => {
    const p = new URLSearchParams();
    if (queue) p.set('queue', queue);
    if (identifier) p.set('identifier', identifier); // D-54: exact match through the blind index
    return http.get<Paged<CredentialRow>>(`/credentials${p.size ? `?${p}` : ''}`);
  },
});
export const useMyCredentials = () => useQuery({ queryKey: ['my-credentials'], queryFn: () => http.get<Paged<CredentialRow>>('/credentials/me') });
export const useMyRequirements = () => useQuery({ queryKey: ['my-credentials', 'requirements'], queryFn: () => http.get<Paged<Requirement & { template: Template }>>('/credentials/me/requirements') });
export const useDocuments = (credentialId: number | null) => useQuery({
  queryKey: ['documents', credentialId], enabled: credentialId !== null,
  queryFn: () => http.get<Paged<DocumentRow>>(`/credentials/${credentialId}/documents`),
});
export const useEligibility = () => useQuery({ queryKey: ['eligibility'], queryFn: () => http.get<Paged<StateRow>>('/eligibility') });
export const useMyEligibility = () => useQuery({ queryKey: ['eligibility', 'me'], queryFn: () => http.get<StateRow>('/eligibility/me'), retry: false });
export const useWaivers = () => useQuery({ queryKey: ['waivers'], queryFn: () => http.get<Paged<Waiver>>('/waivers') });

/** One mutation hook for every credential action; each refreshes every dependent view. */
export function useCredentialAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (a:
      | { kind: 'verify' | 'approve'; id: number }
      | { kind: 'suspend' | 'revoke' | 'reject'; id: number; reason: string }
      | { kind: 'record'; body: object; self: boolean }
      | { kind: 'renew'; id: number; body: object }
      | { kind: 'upload'; id: number; file: File }
      | { kind: 'requirement'; body: object }
      | { kind: 'requirementUpdate'; id: number; body: object }
      | { kind: 'requirementDelete'; id: number }
      | { kind: 'template'; id: number; body: object }
      | { kind: 'templateCreate'; body: object }
      | { kind: 'categoryCreate'; body: object }
      | { kind: 'categoryUpdate'; code: string; body: object }
      | { kind: 'waiver'; body: object }) => {
      switch (a.kind) {
        case 'verify': return http.post(`/credentials/${a.id}/verify`, {});
        case 'approve': return http.post(`/credentials/${a.id}/renewal/approve`, {});
        case 'suspend': return http.post(`/credentials/${a.id}/suspend`, { reason: a.reason });
        case 'revoke': return http.post(`/credentials/${a.id}/revoke`, { reason: a.reason });
        case 'reject': return http.post(`/credentials/${a.id}/renewal/reject`, { reason: a.reason });
        case 'record': return http.post(a.self ? '/credentials/me' : '/credentials', a.body);
        case 'renew': return http.post(`/credentials/${a.id}/renewal`, a.body);
        case 'upload': return http.upload(`/credentials/${a.id}/documents`, a.file);
        case 'requirement': return http.post('/credential-requirements', a.body);
        case 'requirementUpdate': return http.put(`/credential-requirements/${a.id}`, a.body);
        case 'requirementDelete': return http.delete(`/credential-requirements/${a.id}`);
        case 'template': return http.patch(`/credential-templates/${a.id}`, a.body);
        case 'templateCreate': return http.post('/credential-templates', a.body);
        case 'categoryCreate': return http.post('/credential-categories', a.body);
        case 'categoryUpdate': return http.patch(`/credential-categories/${a.code}`, a.body);
        case 'waiver': return http.post('/waivers', a.body);
      }
    },
    onSuccess: () => invalidateAll(qc),
  });
}
