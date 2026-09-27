import type { EventRow } from "@/lib/calendar";

/**
 * Builds an iCalendar (.ics) feed the phone's calendar app can subscribe to.
 * Times are Stockholm wall-clock times, so the feed carries the Europe/Stockholm
 * time zone definition and needs no conversion.
 */

const TZID = "Europe/Stockholm";

const VTIMEZONE = [
  "BEGIN:VTIMEZONE",
  `TZID:${TZID}`,
  `X-LIC-LOCATION:${TZID}`,
  "BEGIN:DAYLIGHT",
  "TZOFFSETFROM:+0100",
  "TZOFFSETTO:+0200",
  "TZNAME:CEST",
  "DTSTART:19700329T020000",
  "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU",
  "END:DAYLIGHT",
  "BEGIN:STANDARD",
  "TZOFFSETFROM:+0200",
  "TZOFFSETTO:+0100",
  "TZNAME:CET",
  "DTSTART:19701025T030000",
  "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU",
  "END:STANDARD",
  "END:VTIMEZONE",
];

function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}

/** RFC 5545: lines longer than 75 octets are folded with CRLF + space. */
function fold(line: string): string {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const out: string[] = [];
  let cur = "";
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, "utf8") > (out.length === 0 ? 75 : 74)) { out.push(cur); cur = ""; }
    cur += ch;
  }
  out.push(cur);
  return out.join("\r\n ");
}

const compact = (iso: string) => iso.replace(/-/g, "");                       // 2026-10-03 → 20261003
const stamp = (iso: string, t: string) => `${compact(iso)}T${t.slice(0, 5).replace(":", "")}00`; // → 20261003T180000

function addDaysISO(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d + n));
  return x.toISOString().slice(0, 10);
}

function addHourStamp(iso: string, t: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const [hh, mm] = t.split(":").map(Number);
  const x = new Date(Date.UTC(y, m - 1, d, hh + 1, mm));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${x.getUTCFullYear()}${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}T${p(x.getUTCHours())}${p(x.getUTCMinutes())}00`;
}

function utcNow(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function vevent(e: EventRow, host: string): string[] {
  const lines = ["BEGIN:VEVENT", `UID:${e.id}@${host}`, `DTSTAMP:${utcNow()}`];
  const lastDay = e.end_date ?? e.date;
  if (!e.start_time) {
    lines.push(`DTSTART;VALUE=DATE:${compact(e.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compact(addDaysISO(lastDay, 1))}`);   // DTEND is exclusive
  } else {
    lines.push(`DTSTART;TZID=${TZID}:${stamp(e.date, e.start_time)}`);
    lines.push(`DTEND;TZID=${TZID}:${e.end_time ? stamp(lastDay, e.end_time) : addHourStamp(lastDay, e.start_time)}`);
  }
  lines.push(`SUMMARY:${esc(e.title)}`);
  if (e.location) lines.push(`LOCATION:${esc(e.location)}`);
  if (e.notes) lines.push(`DESCRIPTION:${esc(e.notes)}`);
  const upd = new Date(e.updated_at);
  if (!isNaN(upd.getTime())) {
    lines.push(`LAST-MODIFIED:${upd.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}`);
    lines.push(`SEQUENCE:${Math.floor(upd.getTime() / 1000)}`);
  }
  lines.push("END:VEVENT");
  return lines;
}

export function buildICS(events: EventRow[], calendarName: string, host: string): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Minhwa Association//Member app//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${esc(calendarName)}`,
    `X-WR-TIMEZONE:${TZID}`,
    "REFRESH-INTERVAL;VALUE=DURATION:PT1H",
    "X-PUBLISHED-TTL:PT1H",
    ...VTIMEZONE,
    ...events.flatMap((e) => vevent(e, host)),
    "END:VCALENDAR",
  ];
  return lines.map(fold).join("\r\n") + "\r\n";
}
