/**
 * Monthly passes (v16). Paying 100 kr per session stays; a pass covers seats for one period instead.
 *   twice     — up to 2 sessions in a Mon–Fri week (the 3rd that week is 100 kr)
 *   unlimited — any number, at most 4 upcoming seats held at a time
 *   crew      — Unlimited at the Crew price, for members the admin gives the Crew rate (with an end date)
 * One period for everyone: settings.pass_start_day (1 → 1 Nov – 30 Nov). A pass works from "I have paid".
 * DB: passes, passes_view, bookings.pass_id, members.crew_rate_until, payments.kind = 'pass'.
 */

import { MONTHS, parseISODate } from "@/lib/dates";

export type PassKind = "twice" | "unlimited" | "crew";

export const PASS_KINDS: { key: PassKind; label: string; hint: string }[] = [
  { key: "twice", label: "Twice a week", hint: "Up to 2 sessions a week (Mon–Fri). A 3rd session that week is the usual price." },
  { key: "unlimited", label: "Unlimited", hint: "Come as often as you like — up to 4 upcoming seats booked at a time." },
  { key: "crew", label: "Crew Unlimited", hint: "Unlimited at the Crew price — for members who help run the association's activities." },
];

export function passLabel(kind: string | null | undefined): string {
  return PASS_KINDS.find((k) => k.key === kind)?.label ?? "Pass";
}

/** A row of passes_view. */
export type PassRow = {
  id: string;
  member_id: string;
  member_name: string;
  kind: PassKind;
  label: string;
  period_start: string;
  period_end: string;
  price_sek: number;
  status: "active" | "cancelled";
  created_at: string;
  cancelled_at: string | null;
  payment_id: string | null;
  code: string | null;
  payment_status: "pending" | "claimed" | "confirmed" | "refunded" | "cancelled" | null;
  claimed_at: string | null;
  confirmed_at: string | null;
  seats: number;
  seats_upcoming: number;
};

/** A row of pass_offer(): the current period and the next, and whether a pass can be bought for it now. */
export type PassOffer = { period_start: string; period_end: string; buy_from: string; open: boolean };

/** Works from "I have paid" on. */
export function passWorks(p: Pick<PassRow, "status" | "payment_status"> | null | undefined): boolean {
  return !!p && p.status === "active" && (p.payment_status === "claimed" || p.payment_status === "confirmed");
}

/** "1 – 30 November" · "15 October – 14 November" */
export function periodLabel(startISO: string, endISO: string): string {
  const s = parseISODate(startISO), e = parseISODate(endISO);
  return s.getMonth() === e.getMonth()
    ? `${s.getDate()} – ${e.getDate()} ${MONTHS[s.getMonth()]}`
    : `${s.getDate()} ${MONTHS[s.getMonth()]} – ${e.getDate()} ${MONTHS[e.getMonth()]}`;
}

/** "November" when the period is a calendar month, otherwise the dates. */
export function periodName(startISO: string, endISO: string): string {
  const s = parseISODate(startISO), e = parseISODate(endISO);
  const lastOfMonth = new Date(s.getFullYear(), s.getMonth() + 1, 0).getDate();
  return s.getDate() === 1 && e.getDate() === lastOfMonth && s.getMonth() === e.getMonth() ? MONTHS[s.getMonth()] : periodLabel(startISO, endISO);
}

/** "12 Oct" */
export function shortDay(iso: string): string {
  const d = parseISODate(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

/** Whole days from a to b (ISO dates). */
export function daysBetween(aISO: string, bISO: string): number {
  return Math.round((parseISODate(bISO).getTime() - parseISODate(aISO).getTime()) / 86400000);
}

/** The reminder shows this many days before a pass ends. */
export const PASS_REMIND_DAYS = 5;

/** my_pass_cover(): what booking a seat on that date would cost me. */
export type PassCover = "pass" | "week_used" | "cap" | "unpaid" | "none";
