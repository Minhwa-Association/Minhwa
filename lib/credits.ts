/**
 * Credits — 1 credit = 1 kr. The Treasurer gives them to members (mostly Crew) for helping with the
 * association's activities instead of pay; members spend them in the Store or on a seat.
 * DB: credit_movements (grant + · spend − · return + · adjust ±), payments.credit_sek / credit_returned_sek.
 */

import type { createClient } from "@/lib/supabase/server";

type DB = Awaited<ReturnType<typeof createClient>>;

/** Given to one person in one year above this (kr), check employer's fees / tax with the accountant. */
export const CREDIT_YEAR_NOTICE = 1000;

export type CreditKind = "grant" | "spend" | "return" | "adjust";

export const CREDIT_KIND_LABEL: Record<CreditKind, string> = {
  grant: "Given",
  spend: "Used",
  return: "Back",
  adjust: "Correction",
};

/** A row of credit_balances (one per member who has ever had credits). */
export type CreditBalance = {
  member_id: string;
  name: string;
  roles: string[] | null;
  active: boolean;
  balance: number;
  granted_this_year: number;
  granted_total: number;
  last_at: string | null;
};

/** A row of credit_history. */
export type CreditLine = {
  id: string;
  member_id: string;
  member_name: string;
  amount: number;
  kind: CreditKind;
  note: string | null;
  event_id: string | null;
  payment_id: string | null;
  order_item_id: string | null;
  created_at: string;
  voided_at: string | null;
  payment_code: string | null;
  created_by_name: string | null;
  voided_by_name: string | null;
};

/** "1 credit" · "150 credits" */
export function credits(n: number | string | null | undefined): string {
  const v = Math.round(Number(n ?? 0));
  return `${v} credit${Math.abs(v) === 1 ? "" : "s"}`;
}

/** "+150" · "−40" */
export function signed(n: number): string {
  return n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

/** What a history line says: the note, or the kind when there is none. */
export function creditText(l: Pick<CreditLine, "kind" | "note">): string {
  return l.note?.trim() || CREDIT_KIND_LABEL[l.kind];
}

/** The credits still on a payment (used, minus what went back). */
export function creditsHeld(p: { credit_sek?: number | null; credit_returned_sek?: number | null } | null | undefined): number {
  return Math.max(0, Number(p?.credit_sek ?? 0) - Number(p?.credit_returned_sek ?? 0));
}

/** Refunding one order line: credits go back first, only the rest is sent with Swish (same rule as refund_order_item). */
export function refundSplit(lineValue: number, payment: { credit_sek?: number | null; credit_returned_sek?: number | null } | null | undefined): { credits: number; swish: number } {
  const c = Math.min(lineValue, creditsHeld(payment));
  return { credits: c, swish: lineValue - c };
}

/** A member's balance, 0 when they have never had credits. */
export async function balanceOf(supabase: DB, memberId: string): Promise<number> {
  const { data } = await supabase.from("credit_balances").select("balance").eq("member_id", memberId).maybeSingle();
  return Number(data?.balance ?? 0);
}
