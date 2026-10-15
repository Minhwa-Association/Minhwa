/**
 * Kvitton (v17) — the receipt a member gets for every payment the association has received.
 * Safe to import anywhere (no server code); the PDF itself is made in lib/receipt-pdf.ts.
 */

export type ReceiptLine = { text: string; amount_sek: number };

/** A row of sales_receipts — a snapshot taken the moment the payment became "Paid". */
export type SalesReceipt = {
  id: string;
  number: string;               // K2026-0001
  year: number;
  seq: number;
  payment_id: string;
  member_id: string | null;
  member_name: string;
  kind: "seat" | "pass" | "material" | "membership" | string;
  payment_code: string | null;  // S0231
  title: string;                // "Painting session" · "Monthly pass" · "Store order"
  description: string;
  lines: ReceiptLine[];
  total_sek: number | string;
  swish_sek: number | string;
  credit_sek: number;
  credit_source: string | null;
  paid_on: string;              // YYYY-MM-DD
  bank_tx_id: string | null;
  org_name: string;
  org_number: string;
  org_address: string;
  org_email: string;
  swish_number: string;
  note: string;
  issued_at: string;
  issued_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  drive_file_id: string | null;
  drive_saved_at: string | null;
};

export const RECEIPT_SELECT = "id, number, year, seq, payment_id, member_id, member_name, kind, payment_code, title, description, lines, total_sek, swish_sek, credit_sek, credit_source, paid_on, bank_tx_id, org_name, org_number, org_address, org_email, swish_number, note, issued_at, issued_by, voided_at, void_reason, drive_file_id, drive_saved_at";

export const KIND_WORD: Record<string, string> = { seat: "Seat", pass: "Pass", material: "Store", membership: "Membership" };

export function num(v: number | string | null | undefined): number {
  const n = typeof v === "string" ? Number(v) : v ?? 0;
  return Number.isFinite(n) ? n : 0;
}

/** "100 kr" · "118,50 kr" */
export function money(v: number | string | null | undefined): string {
  const n = num(v);
  const whole = Math.abs(n - Math.round(n)) < 0.005;
  return `${whole ? String(Math.round(n)) : n.toFixed(2).replace(".", ",")} kr`;
}

/** "2026-10-15 K2026-0001 Painting session — Rock 100 kr.pdf" — the name in Drive */
export function receiptFileName(r: Pick<SalesReceipt, "paid_on" | "number" | "title" | "member_name" | "total_sek" | "voided_at">): string {
  const base = `${r.paid_on} ${r.number} ${r.title} — ${r.member_name} ${money(r.total_sek).replace(" kr", " kr")}${r.voided_at ? " (VOID)" : ""}`;
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim() + ".pdf";
}

/** What the member sees on the list: "Swish 100 kr" · "Credits 100 kr" · "Swish 60 kr + credits 40 kr" */
export function paidWith(r: Pick<SalesReceipt, "swish_sek" | "credit_sek">): string {
  const s = num(r.swish_sek), c = num(r.credit_sek);
  if (s > 0 && c > 0) return `Swish ${money(s)} + credits ${money(c)}`;
  if (c > 0) return `Credits ${money(c)}`;
  return `Swish ${money(s)}`;
}

/** "123 196 80 98" from "1231968098" */
export function swishPretty(n: string): string {
  const d = (n ?? "").replace(/[^0-9]/g, "");
  return d.length === 10 ? `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}` : n ?? "";
}
