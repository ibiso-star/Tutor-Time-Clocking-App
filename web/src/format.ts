/** Display helpers. All instants arrive as UTC ISO strings and are shown in an explicit timezone. */
export function hm(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

export function clockDigits(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function time(iso: string | null | undefined, tz: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

export function timeWithSeconds(iso: string, tz: string): string {
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}

export function dateTime(iso: string | null | undefined, tz: string): string {
  if (!iso) return "—";
  return new Intl.DateTimeFormat(undefined, { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(new Date(iso));
}

export function day(isoDate: string): string {
  // isoDate is a local calendar date (YYYY-MM-DD); format it without shifting zones.
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y!, m! - 1, d!)));
}

export function tzShort(tz: string): string {
  const part = new Intl.DateTimeFormat(undefined, { timeZone: tz, timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName");
  return part?.value ?? tz;
}

/** Converts an <input type="datetime-local"> value interpreted in `tz` into a UTC ISO string. */
export function localInputToIso(value: string, tz: string): string {
  const [datePart, timePart] = value.split("T");
  const [y, mo, d] = datePart!.split("-").map(Number);
  const [h, mi] = timePart!.split(":").map(Number);
  // Start from the naive UTC guess and correct by the zone's offset at that instant (twice for DST edges).
  let guess = Date.UTC(y!, mo! - 1, d!, h!, mi!);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y!, mo! - 1, d!, h!, mi!) - offsetMs(guess, tz);
  return new Date(guess).toISOString();
}

/** Formats a UTC ISO instant as a datetime-local input value in `tz`. */
export function isoToLocalInput(iso: string, tz: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function offsetMs(instant: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(instant))
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

export function todayIn(tz: string, offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

export function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

export const ISSUE_LABELS: Record<string, string> = {
  missed_clock_out: "Forgot to clock out",
  wrong_clock_in: "Clock-in time is wrong",
  wrong_clock_out: "Clock-out time is wrong",
  missed_break: "Break not recorded correctly",
  other: "Something else",
};

/** Local hour-of-day (fractional) of an instant in `tz`, for laying events on a day track. */
export function localHour(iso: string | number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(iso))
      .map((p) => [p.type, p.value]),
  );
  return Number(parts.hour) + Number(parts.minute) / 60;
}
