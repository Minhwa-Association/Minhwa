/** Days with sessions: Monday–Saturday (v19.5 added Saturday). Index = weekday − 1. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
/** The last day of a board week (Saturday) = Monday + this. */
export const WEEK_LAST = WEEKDAYS.length - 1;

/** ISO date string (YYYY-MM-DD) in local time. */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseISODate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Monday of the week containing d. */
export function mondayOf(d: Date): Date {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = (x.getDay() + 6) % 7; // Mon = 0
  x.setDate(x.getDate() - dow);
  return x;
}

export function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

export function isValidISODate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parseISODate(s).getTime());
}

export const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

/** "21 – 26 September" or "28 September – 3 October" (Monday to Saturday) */
export function weekLabel(monday: Date): string {
  const fri = addDays(monday, WEEK_LAST);
  if (monday.getMonth() === fri.getMonth()) {
    return `${monday.getDate()} – ${fri.getDate()} ${MONTHS[monday.getMonth()]}`;
  }
  return `${monday.getDate()} ${MONTHS[monday.getMonth()]} – ${fri.getDate()} ${MONTHS[fri.getMonth()]}`;
}

/** "22/9" */
export function shortDate(d: Date): string {
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

/** "Tuesday 22 September" */
export function longDate(d: Date): string {
  const wd = WEEKDAYS_LONG[(d.getDay() + 6) % 7] ?? "";
  return `${wd} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

/** "10:00" from "10:00:00" */
export function hm(t: string): string {
  return t.slice(0, 5);
}

export function sessionLabel(s: "day" | "evening"): string {
  return s === "day" ? "Day" : "Evening";
}

export const DAYS7 = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/** "Sat" — any day of the week */
export function dayShort(d: Date): string {
  return DAYS7[(d.getDay() + 6) % 7];
}

/** "October 2026" */
export function monthYear(d: Date): string {
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** "3 Oct" */
export function dayMonth(d: Date): string {
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

/** Today's date in Stockholm as YYYY-MM-DD (the server runs in UTC). */
export function todayStockholm(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(new Date());
}
