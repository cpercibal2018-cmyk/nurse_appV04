// Gregorian → Umm al-Qura (Saudi civil calendar) via Intl's islamic-umalqura
// calendar — the only basis the spec accepts (§4.2). The stored Hijri value is
// computed once at entry so it cannot drift if ICU calendar tables change.

const PARTS_FMT = new Intl.DateTimeFormat('en-SA-u-ca-islamic-umalqura', {
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

/**
 * Canonical stored form `YYYY-MM-DD` (Hijri), e.g. 2026-09-19 → `1448-04-08`.
 * Accepts a Date (read as a UTC calendar date) or an ISO `YYYY-MM-DD` string.
 */
export function toHijriIso(value: Date | string): string {
  const date = typeof value === 'string' ? new Date(`${value.slice(0, 10)}T00:00:00Z`) : value;
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  const parts = PARTS_FMT.formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  const year = get('year').replace(/\D/g, '').padStart(4, '0');
  const month = get('month').padStart(2, '0');
  const day = get('day').padStart(2, '0');
  return `${year}-${month}-${day}`;
}
