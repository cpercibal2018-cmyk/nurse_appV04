// The credential-type form (Catalog tab) as API bodies. Kept pure so the
// "send only what changed" rule is testable: the approver of a catalog change
// (D-24) sees exactly what the requester changed, nothing else.

import type { FieldDef, Template } from './api';

export type FieldRowValue = { key: string; label: string; type: FieldDef['type']; required: boolean; isIssueDate?: boolean; isExpiryDate?: boolean };
export type TemplateFormValues = {
  code?: string; name: string; categoryCode: string; description?: string | null; hasExpiry: boolean; requiresUpload: boolean;
  gracePeriodDays: number; displayOrder: number; isActive: boolean; fields?: FieldRowValue[]; reason: string;
};

export const isDateType = (type?: string) => type === 'date' || type === 'date_hijri';

/** The form's rows as the API's `fieldDefs`: the order on screen is the display order. */
export const toFieldDefs = (rows: readonly FieldRowValue[] = []): FieldDef[] => rows.map((f, i) => ({
  key: f.key, label: f.label.trim(), type: f.type, required: f.required === true, displayOrder: i + 1,
  ...(isDateType(f.type) && f.isIssueDate ? { isIssueDate: true } : {}),
  ...(isDateType(f.type) && f.isExpiryDate ? { isExpiryDate: true } : {}),
}));

/** A stored template as form values. */
export const toFormValues = (x: Template): TemplateFormValues => ({
  name: x.name, categoryCode: x.categoryCode, description: x.description, hasExpiry: x.hasExpiry, requiresUpload: x.requiresUpload,
  gracePeriodDays: x.gracePeriodDays, displayOrder: x.displayOrder, isActive: x.isActive, reason: '',
  fields: x.fieldDefs.map((f) => ({ key: f.key, label: f.label, type: f.type, required: f.required, isIssueDate: f.isIssueDate === true, isExpiryDate: f.isExpiryDate === true })),
});

const comparable = (v: Omit<TemplateFormValues, 'code' | 'reason'>) => ({
  name: v.name.trim(), categoryCode: v.categoryCode, description: v.description?.trim() ?? '', hasExpiry: v.hasExpiry, requiresUpload: v.requiresUpload,
  gracePeriodDays: v.gracePeriodDays, displayOrder: v.displayOrder, fieldDefs: toFieldDefs(v.fields),
});

/** Body for POST /credential-templates. */
export function createBody(v: TemplateFormValues): Record<string, unknown> {
  const { description, ...rest } = comparable(v);
  return { code: v.code, ...rest, ...(description ? { description } : {}), reason: v.reason };
}

/** Body for PATCH /credential-templates/:id — only the properties that differ from `before`, plus the reason. */
export function changeBody(before: Template, v: TemplateFormValues): Record<string, unknown> {
  const was: Record<string, unknown> = { ...comparable(toFormValues(before)), isActive: before.isActive };
  const now: Record<string, unknown> = { ...comparable(v), isActive: v.isActive };
  return { ...Object.fromEntries(Object.entries(now).filter(([k, val]) => JSON.stringify(val) !== JSON.stringify(was[k]))), reason: v.reason };
}
