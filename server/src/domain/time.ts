import { DateTime } from "luxon";

/** Local calendar date (YYYY-MM-DD) of a UTC instant in an IANA timezone. */
export function localDate(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toISODate()!;
}

/**
 * UTC instants bounding a range of local calendar days, inclusive of both dates.
 * DST-safe: a 23- or 25-hour local day yields a 23- or 25-hour range.
 */
export function localDateRange(from: string, to: string, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(from, { zone: timezone }).startOf("day");
  const end = DateTime.fromISO(to, { zone: timezone }).plus({ days: 1 }).startOf("day");
  if (!start.isValid || !end.isValid) throw new Error("Invalid date range");
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export function todayLocal(now: Date, timezone: string): string {
  return localDate(now, timezone);
}

/** Human-readable local timestamp with zone abbreviation, e.g. "2026-03-08 09:15 PDT". */
export function formatLocal(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat("yyyy-LL-dd HH:mm ZZZZ");
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && DateTime.fromISO(value).isValid;
}
