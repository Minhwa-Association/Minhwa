import { dayShort, parseISODate, sessionLabel, shortDate } from "@/lib/dates";

/** payments.status — pending (not paid) → claimed ("I have paid") → confirmed (treasurer) → refunded; cancelled = booking cancelled unpaid */
export type PaymentStatus = "pending" | "claimed" | "confirmed" | "refunded" | "cancelled";

export const PAYMENT_LABEL: Record<PaymentStatus, string> = {
  pending: "Not paid yet",
  claimed: "Awaiting confirmation",
  confirmed: "Paid",
  refunded: "Refunded",
  cancelled: "Cancelled",
};

export function paymentLabel(s?: string | null): string {
  return (s && PAYMENT_LABEL[s as PaymentStatus]) || "";
}

/** CSS class used by the roster / admin board: green = confirmed, gold = claimed */
export function paymentClass(s?: string | null): "paid" | "pending" | "" {
  if (s === "confirmed") return "paid";
  if (s === "claimed") return "pending";
  return "";
}

/** A row of payments_view (payments + member name + booking date/slot + linked bank line). */
export type PaymentRow = {
  id: string;
  code: string | null;
  kind: "seat" | "material" | "membership";
  status: PaymentStatus;
  amount_sek: number;
  note: string | null;
  member_id: string | null;
  ref_id: string | null;
  created_at: string;
  claimed_at: string | null;
  confirmed_at: string | null;
  refunded_at: string | null;
  member_name: string | null;
  booking_date: string | null;
  booking_status: "booked" | "cancelled" | null;
  session: "day" | "evening" | null;
  weekday: number | null;
  bank_tx_id: string | null;
  bank_date: string | null;
  bank_name: string | null;
};

/** "05/10 Mon Day" for a seat payment, otherwise the Swish message without its code */
export function describePayment(p: Pick<PaymentRow, "kind" | "booking_date" | "session" | "note" | "code">): string {
  if (p.kind === "seat" && p.booking_date && p.session) {
    const d = parseISODate(p.booking_date);
    return `${shortDate(d)} ${dayShort(d)} ${sessionLabel(p.session)}`;
  }
  const note = p.note ?? "";
  return p.code && note.startsWith(p.code) ? note.slice(p.code.length).trim() : note;
}

export type BankTxStatus = "unmatched" | "suggested" | "matched" | "confirmed" | "ignored" | "outgoing";

export type BankTx = {
  id: string;
  booked_on: string;
  amount_sek: number;
  title: string;
  counterparty: string | null;
  message: string | null;
  own_notes: string | null;
  balance_sek: number | null;
  status: BankTxStatus;
  payment_id: string | null;
  imported_at: string;
  payment?: {
    id: string; code: string | null; note: string | null; amount_sek: number; status: string; kind: string;
    member: { name: string } | null;
  } | null;
};

/** "100 kr" · "118,83 kr" — Swedish style, no decimals when whole */
export function kr(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "";
  const v = typeof n === "string" ? Number(n) : n;
  if (!Number.isFinite(v)) return String(n);
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  const s = whole ? String(Math.round(v)) : v.toFixed(2).replace(".", ",");
  return `${s} kr`;
}

/** "15/9" from "2026-09-15" */
export function bankDate(iso: string): string {
  return shortDate(parseISODate(iso));
}

/** Who the bank line is from/to, plus the message when it says something the name doesn't. */
export function bankWho(t: Pick<BankTx, "title" | "counterparty" | "message" | "own_notes">): { who: string; detail: string | null } {
  const who = t.counterparty ?? t.title;
  const bits: string[] = [];
  if (t.counterparty && t.title !== t.counterparty && !t.title.includes(t.counterparty)) bits.push(t.title);
  if (t.message && t.message !== t.counterparty) bits.push(`“${t.message}”`);
  if (t.own_notes) bits.push(t.own_notes);
  return { who, detail: bits.length ? bits.join(" · ") : null };
}
