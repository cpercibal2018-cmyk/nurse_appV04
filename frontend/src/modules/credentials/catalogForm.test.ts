import { describe, expect, it } from 'vitest';
import type { Template } from './api';
import { changeBody, createBody, toFieldDefs, toFormValues } from './catalogForm';

const stored: Template = {
  id: 7, code: 'SCFHS', name: 'SCFHS licence', categoryCode: 'LICENSE', description: null, hasExpiry: true, requiresUpload: true,
  gracePeriodDays: 0, displayOrder: 1, isActive: true,
  fieldDefs: [
    { key: 'licence_number', label: 'Licence number', type: 'text', required: true, displayOrder: 1 },
    { key: 'issue_date', label: 'Issue date', type: 'date', required: true, displayOrder: 2, isIssueDate: true },
    { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true },
  ],
};

describe('credential type form', () => {
  it('round-trips a stored type unchanged: an untouched edit sends only the reason', () => {
    expect(changeBody(stored, { ...toFormValues(stored), reason: 'nothing really' })).toEqual({ reason: 'nothing really' });
  });

  it('sends only what changed', () => {
    const v = toFormValues(stored);
    expect(changeBody(stored, { ...v, gracePeriodDays: 14, reason: 'hospital policy 2026' })).toEqual({ gracePeriodDays: 14, reason: 'hospital policy 2026' });
    expect(changeBody(stored, { ...v, description: '  ', isActive: false, reason: 'retired type' })).toEqual({ isActive: false, reason: 'retired type' });
  });

  it('sends the whole field list, renumbered, when a field is moved, added or removed', () => {
    const v = toFormValues(stored);
    const moved = { ...v, fields: [v.fields![0]!, v.fields![2]!, v.fields![1]!], reason: 'expiry first please' };
    expect((changeBody(stored, moved).fieldDefs as { key: string; displayOrder: number }[]).map((f) => [f.key, f.displayOrder]))
      .toEqual([['licence_number', 1], ['expiry_date', 2], ['issue_date', 3]]);
  });

  it('drops date flags on non-date fields and trims labels', () => {
    expect(toFieldDefs([{ key: 'ref', label: ' Reference ', type: 'text', required: false, isIssueDate: true, isExpiryDate: true }]))
      .toEqual([{ key: 'ref', label: 'Reference', type: 'text', required: false, displayOrder: 1 }]);
  });

  it('builds a create body without an empty description', () => {
    const body = createBody({ ...toFormValues(stored), code: 'ACLS2', description: '', reason: 'new credential type' });
    expect(body).toMatchObject({ code: 'ACLS2', name: 'SCFHS licence', categoryCode: 'LICENSE', reason: 'new credential type' });
    expect(body).not.toHaveProperty('description');
    expect(body).not.toHaveProperty('isActive');
    expect((body.fieldDefs as unknown[]).length).toBe(3);
  });
});
