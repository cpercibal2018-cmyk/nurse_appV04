// Calendar-day helpers. Workforce dates follow Asia/Riyadh (spec §3.3:
// "Session expiry comparisons use UTC. Workforce date rules use Asia/Riyadh").
// A calendar day is an ISO string 'YYYY-MM-DD'; ISO strings compare correctly
// with < and >, so no Date arithmetic is needed for date rules.

export type IsoDate = string;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** The Asia/Riyadh calendar day of an instant. */
export function riyadhDate(instant: Date = new Date()): IsoDate {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** A `@db.Date` value (stored as UTC midnight) as its calendar day. */
export function dbDate(d: Date): IsoDate {
  return d.toISOString().slice(0, 10);
}

/** A calendar day as the Date Prisma expects for a `@db.Date` column. */
export function toDbDate(iso: IsoDate): Date {
  if (!ISO.test(iso)) throw new RangeError(`Not a calendar date: ${iso}`);
  const d = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || dbDate(d) !== iso) throw new RangeError(`Not a calendar date: ${iso}`);
  return d;
}

export function addDays(iso: IsoDate, days: number): IsoDate {
  return dbDate(new Date(toDbDate(iso).getTime() + days * 86_400_000));
}

export function daysBetween(from: IsoDate, to: IsoDate): number {
  return Math.round((toDbDate(to).getTime() - toDbDate(from).getTime()) / 86_400_000);
}

export const isIsoDate = (s: string) => ISO.test(s) && (() => { try { toDbDate(s); return true; } catch { return false; } })();
