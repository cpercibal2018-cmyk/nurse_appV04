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

const DAY_MS = 86_400_000;

/**
 * Hijri → Gregorian under the SAME ICU Umm al-Qura calendar as toHijriIso.
 * Intl formats but cannot parse that calendar; search calendar days and only
 * accept an exact round-trip. In particular, a Hijri year must never be stored
 * as a Gregorian year in the clinical expiryDate column.
 */
export function fromHijriIso(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid Umm al-Qura date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 30) {
    throw new RangeError(`Invalid Umm al-Qura date: ${value}`);
  }

  // Approximate solar year (only a search bound, never the converted result).
  // A five-year window covers the accumulated leap-month/day variation.
  const solarYear = Math.floor(621.58 + 0.970224 * year);
  let lo = Date.UTC(solarYear - 2, 0, 1) / DAY_MS;
  let hi = Date.UTC(solarYear + 2, 11, 31) / DAY_MS;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const gregorian = new Date(mid * DAY_MS);
    const formatted = toHijriIso(gregorian);
    if (formatted === value) {
      const iso = gregorian.toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) break; // database dates use four-digit Gregorian years
      return iso;
    }
    if (formatted < value) lo = mid + 1;
    else hi = mid - 1;
  }
  throw new RangeError(`Invalid Umm al-Qura date: ${value}`);
}
