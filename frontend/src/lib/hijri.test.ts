import { describe, expect, it } from 'vitest';
import { toHijriShort } from './hijri';

// Same Umm al-Qura anchors as the backend test (V03 test section [7]).
describe('toHijriShort (display only)', () => {
  it.each([
    ['2026-09-19', '08/04/1448 AH'],
    ['2026-06-16', '01/01/1448 AH'],
    ['2025-03-01', '01/09/1446 AH'],
  ])('%s → %s', (g, h) => { expect(toHijriShort(g)).toBe(h); });

  it('accepts a date-picker value and returns nothing for an invalid date', () => {
    expect(toHijriShort({ format: () => '2026-09-19' })).toBe('08/04/1448 AH');
    expect(toHijriShort('not-a-date')).toBe('');
  });
});
