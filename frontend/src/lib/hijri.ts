// Display-only Umm al-Qura preview for date pickers (D-12: small helpers are
// duplicated rather than shared). The stored Hijri value is always converted
// by the server (backend/src/lib/hijri.ts); this never reaches the API.

type DateLike = { format: (f: string) => string } | string;

const FMT = new Intl.DateTimeFormat('en-SA-u-ca-islamic-umalqura', { timeZone: 'UTC', day: 'numeric', month: 'numeric', year: 'numeric' });

/** `2026-09-19` → `08/04/1448 AH` (Saudi DD/MM/YYYY order). */
export function toHijriShort(value: DateLike): string {
  const iso = typeof value === 'string' ? value.slice(0, 10) : value.format('YYYY-MM-DD');
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return '';
  const parts = FMT.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day').padStart(2, '0')}/${get('month').padStart(2, '0')}/${get('year').replace(/\D/g, '')} AH`;
}
