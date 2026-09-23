import { describe, expect, it } from 'vitest';
import { fromHijriIso, toHijriIso } from './hijri.js';

// Independently published Umm al-Qura anchors, carried over verbatim from V03
// test section [7] (app/scripts/verify-employee-fields.mjs).
describe('toHijriIso', () => {
  it.each([
    ['2024-07-07', '1446-01-01'], // 1 Muharram 1446
    ['2025-06-26', '1447-01-01'], // 1 Muharram 1447
    ['2026-06-16', '1448-01-01'], // 1 Muharram 1448
    ['2026-09-19', '1448-04-08'], // 8 Rabi al-Thani 1448
    ['2025-03-01', '1446-09-01'], // 1 Ramadan 1446
    ['2025-03-30', '1446-10-01'], // Eid al-Fitr 1446
    ['2024-04-10', '1445-10-01'], // Eid al-Fitr 1445
    ['2023-01-15', '1444-06-22'], // 22 Jumada al-Akhirah 1444
  ])('%s → %s', (gregorian, hijri) => {
    expect(toHijriIso(gregorian)).toBe(hijri);
  });

  it('treats a Date as its UTC calendar day', () => {
    expect(toHijriIso(new Date('2026-06-01T00:00:00Z'))).toBe('1447-12-15');
  });

  it('rejects an invalid date', () => {
    expect(() => toHijriIso('not-a-date')).toThrow(RangeError);
  });
});

describe('fromHijriIso', () => {
  it.each([
    ['1446-01-01', '2024-07-07'],
    ['1447-01-01', '2025-06-26'],
    ['1448-01-01', '2026-06-16'],
    ['1448-04-08', '2026-09-19'],
    ['1446-10-01', '2025-03-30'],
  ])('converts Umm al-Qura %s to Gregorian %s', (hijri, gregorian) => {
    expect(fromHijriIso(hijri)).toBe(gregorian);
  });

  it.each(['1448-13-01', '1448-01-31', '1448-00-01', '1448-01-00', 'not-a-date'])('rejects invalid %s rather than storing it as a Gregorian date', (hijri) => {
    expect(() => fromHijriIso(hijri)).toThrow(RangeError);
  });
});
