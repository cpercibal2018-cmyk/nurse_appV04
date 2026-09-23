// Shift times (owner decision D-31: V03's times, kept in one place so they can
// change). Hospital time is Asia/Riyadh (UTC+3, no daylight saving), so a
// shift's instants are computed with a fixed offset. Night runs past midnight:
// a Night shift dated D starts at 23:00 on D and ends at 07:00 on D+1.

import type { IsoDate } from '../lib/dates.js';

export type ShiftType = 'Morning' | 'Evening' | 'Night';
export const SHIFT_TYPES: readonly ShiftType[] = ['Morning', 'Evening', 'Night'];

export const SHIFT_TIMES: Readonly<Record<ShiftType, { start: string; end: string }>> = {
  Morning: { start: '07:00', end: '15:00' },
  Evening: { start: '15:00', end: '23:00' },
  Night: { start: '23:00', end: '07:00' },
};

const RIYADH_OFFSET = '+03:00';

/** The start and end instants of a shift on a given date. */
export function shiftWindow(date: IsoDate, shift: ShiftType): { start: Date; end: Date } {
  const t = SHIFT_TIMES[shift];
  const start = new Date(`${date}T${t.start}:00${RIYADH_OFFSET}`);
  let end = new Date(`${date}T${t.end}:00${RIYADH_OFFSET}`);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return { start, end };
}
