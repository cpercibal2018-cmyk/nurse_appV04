import { describe, expect, it } from 'vitest';
import { sameValue } from './same.js';

describe('sameValue', () => {
  it('ignores object key order (jsonb re-sorts keys) but not array order', () => {
    const field = { key: 'expiry_date', label: 'Expiry date', type: 'date', required: true, displayOrder: 3, isExpiryDate: true };
    const fromJsonb = { key: 'expiry_date', type: 'date', label: 'Expiry date', required: true, displayOrder: 3, isExpiryDate: true };
    expect(sameValue([field], [fromJsonb])).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });

  it('treats undefined and null as the same absent value, and nothing else', () => {
    expect(sameValue(undefined, null)).toBe(true);
    expect(sameValue({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(sameValue('', null)).toBe(false);
    expect(sameValue(0, null)).toBe(false);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });
});
