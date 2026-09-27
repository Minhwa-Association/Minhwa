import { dayMonth, dayShort, hm, parseISODate } from "@/lib/dates";

export type EventRow = {
  id: string;
  title: string;
  date: string;               // YYYY-MM-DD
  end_date: string | null;    // multi-day: last day (inclusive)
  start_time: string | null;  // HH:MM:SS, null = all day
  end_time: string | null;
  location: string | null;
  notes: string | null;
  audience: string[];         // [] = everyone
  created_by: string | null;
  updated_at: string;
};

/** Who can see the event — the <select> in the form ↔ the audience array in the database. */
export const AUDIENCES = [
  { key: "everyone", label: "Everyone", roles: [] as string[] },
  { key: "crew", label: "Crew only", roles: ["crew"] },
  { key: "teacher", label: "Teachers only", roles: ["teacher"] },
  { key: "crew_teacher", label: "Crew and teachers", roles: ["crew", "teacher"] },
] as const;

export function audienceToKey(a: string[] | null | undefined): (typeof AUDIENCES)[number]["key"] {
  const set = new Set(a ?? []);
  if (set.size === 0) return "everyone";
  if (set.has("crew") && set.has("teacher")) return "crew_teacher";
  if (set.has("crew")) return "crew";
  return "teacher";
}

export function keyToAudience(key: string): string[] {
  return [...(AUDIENCES.find((x) => x.key === key)?.roles ?? [])];
}

/** "Crew · Teachers" — null when everyone can see it */
export function audienceLabel(a: string[] | null | undefined): string | null {
  const set = new Set(a ?? []);
  if (set.size === 0) return null;
  const parts = [];
  if (set.has("crew")) parts.push("Crew");
  if (set.has("teacher")) parts.push("Teachers");
  return parts.join(" · ");
}

/** "18:00–20:00" · "All day" · "Sat 3 Oct – Mon 5 Oct" · "Sat 3 Oct 18:00 → Sun 4 Oct 10:00" */
export function whenLabel(e: EventRow): string {
  const multi = !!e.end_date && e.end_date !== e.date;
  const start = e.start_time ? hm(e.start_time) : null;
  const end = e.end_time ? hm(e.end_time) : null;
  if (!multi) {
    if (!start) return "All day";
    return end ? `${start}–${end}` : start;
  }
  const d1 = parseISODate(e.date), d2 = parseISODate(e.end_date!);
  const a = `${dayShort(d1)} ${dayMonth(d1)}`, b = `${dayShort(d2)} ${dayMonth(d2)}`;
  if (!start) return `${a} – ${b}`;
  return `${a} ${start} → ${b}${end ? " " + end : ""}`;
}

export function isPast(e: EventRow, todayISO: string): boolean {
  return (e.end_date ?? e.date) < todayISO;
}

export function isToday(e: EventRow, todayISO: string): boolean {
  return e.date <= todayISO && (e.end_date ?? e.date) >= todayISO;
}
