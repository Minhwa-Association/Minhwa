/** Receipts — a member pays for something for the association, sends the receipt, gets it back. */

export const RECEIPTS_BUCKET = "receipts";
export const RECEIPT_ADDRESS = "receipt@minhwa.org";

export type ClaimStatus = "new" | "approved" | "paid" | "declined";

/** A row of claims_view */
export type ClaimRow = {
  id: string;
  code: string;
  status: ClaimStatus;
  source: "email" | "app";
  member_id: string | null;
  sender_email: string | null;
  sender_name: string | null;
  subject: string | null;
  body_text: string | null;
  received_at: string;
  acked_at: string | null;
  merchant: string | null;
  purchased_on: string | null;
  receipt_total: number | string | null;
  receipt_currency: string | null;
  amount_sek: number | string | null;
  vat_sek: number | string | null;
  purpose: string | null;
  category_code: string | null;
  ai_json: Record<string, unknown> | null;
  ai_note: string | null;
  read_at: string | null;
  duplicate_of: string | null;
  approved_amount_sek: number | string | null;
  reviewed_at: string | null;
  reply: string | null;
  note: string | null;
  paid_at: string | null;
  bank_tx_id: string | null;
  suggested_tx_id: string | null;
  created_at: string;
  updated_at: string;
  member_name: string | null;
  member_email: string | null;
  category_name: string | null;
  category_bas: string | null;
  duplicate_code: string | null;
  file_count: number;
  first_path: string | null;
  first_type: string | null;
  bank_date: string | null;
  bank_name: string | null;
  bank_amount: number | string | null;
  bank_message: string | null;
  suggested_date: string | null;
  suggested_name: string | null;
  suggested_amount: number | string | null;
  suggested_message: string | null;
  clearing: string | null;
  account: string | null;
  account_bank: string | null;
  account_holder: string | null;
};

export type ClaimFile = { id: string; claim_id: string; path: string; filename: string | null; content_type: string | null; bytes: number | null; sort: number };

export type LedgerCategory = { code: string; name: string; bas: string; kind: "income" | "expense" | "balance"; sort: number; active: boolean };

export type BankAccount = { member_id: string; clearing: string; account: string; bank: string | null; holder: string | null; updated_at: string };

/** What the member sees */
export const CLAIM_STATUS_LABEL: Record<ClaimStatus, string> = {
  new: "Received — being checked",
  approved: "Approved — payment on its way",
  paid: "Paid",
  declined: "Not approved",
};

/** green when paid, gold while approved, plain otherwise */
export function claimClass(s: ClaimStatus): "paid" | "pending" | "unpaid" | "" {
  if (s === "paid") return "paid";
  if (s === "approved") return "pending";
  if (s === "declined") return "unpaid";
  return "";
}

/** "8327-9 · 123 456 789 0" — how a treasurer would type it into the bank */
export function formatAccount(clearing?: string | null, account?: string | null): string {
  if (!clearing || !account) return "";
  const c = clearing.length === 5 ? `${clearing.slice(0, 4)}-${clearing.slice(4)}` : clearing;
  const a = account.replace(/(\d{3})(?=\d)/g, "$1 ");
  return `${c} · ${a}`;
}

/** "345 kr" · "345.50 kr" — two decimals only when needed */
export function sek(n: number | string | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  const whole = Math.abs(v - Math.round(v)) < 0.005;
  return `${whole ? Math.round(v).toLocaleString("en-GB") : v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} kr`;
}

/** "345.00 SEK" or "₩12,000" style for what the receipt itself says */
export function receiptMoney(total: number | string | null | undefined, currency: string | null | undefined): string {
  const v = Number(total);
  if (!Number.isFinite(v)) return "";
  const cur = (currency ?? "SEK").toUpperCase();
  if (cur === "SEK") return sek(v);
  return `${v.toLocaleString("en-GB", { maximumFractionDigits: 2 })} ${cur}`;
}

/** The one-line story of a claim: "Panduro Hobby · 25 Sep · 345 kr" */
export function claimSummary(c: Pick<ClaimRow, "merchant" | "purchased_on" | "receipt_total" | "receipt_currency" | "amount_sek" | "approved_amount_sek" | "subject">): string {
  const parts: string[] = [];
  if (c.merchant) parts.push(c.merchant);
  if (c.purchased_on) parts.push(new Date(c.purchased_on + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short" }));
  const money = c.approved_amount_sek ?? c.amount_sek;
  if (money != null && money !== "") parts.push(sek(money));
  else if (c.receipt_total != null) parts.push(receiptMoney(c.receipt_total, c.receipt_currency));
  if (parts.length === 0 && c.subject) parts.push(c.subject);
  return parts.join(" · ");
}

/** Attachments worth keeping: pictures and PDFs, not signature logos or calendar files */
export function isReceiptFile(contentType: string | null | undefined, filename: string | null | undefined, size: number | null | undefined, inline: boolean): boolean {
  const ct = (contentType ?? "").toLowerCase();
  const name = (filename ?? "").toLowerCase();
  const isImage = ct.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif)$/.test(name);
  const isPdf = ct === "application/pdf" || name.endsWith(".pdf");
  if (!isImage && !isPdf) return false;
  if (inline && isImage && size != null && size < 40_000) return false;   // tiny inline pictures are logos and signatures
  return true;
}

/** "kvitto (1).JPG" → "kvitto-1.jpg" — a safe storage file name */
export function safeFileName(name: string | null | undefined, fallback: string): string {
  const base = (name ?? "").trim() || fallback;
  const cleaned = base.normalize("NFKD").replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return (cleaned || fallback).toLowerCase().slice(0, 80);
}

/** The reading Claude gives back for a receipt */
export type ReceiptReading = {
  merchant: string | null;
  purchased_on: string | null;      // YYYY-MM-DD
  total: number | null;
  currency: string | null;          // ISO code
  vat: number | null;
  items: string[];
  receipt_kind: "receipt" | "card_slip" | "invoice" | "order_confirmation" | "other" | null;
  addressed_to: string | null;
  purpose: string | null;
  category: string | null;          // one of ledger_categories.code
  confidence: number | null;        // 0–1
  notes: string | null;
};

/** Text of the automatic "received" reply — the only mail the app sends by itself */
export function ackMail(opts: { memberName: string; code: string; summary: string; appUrl: string; hasAccount: boolean }): { subject: string; text: string } {
  const first = opts.memberName.split(/\s+/)[0] || opts.memberName;
  const lines = [
    `Hi ${first},`,
    "",
    `We received your receipt (${opts.code})${opts.summary ? ` — ${opts.summary}` : ""}.`,
    "The treasurer will check it and pay it back to your bank account. You can follow it in the app under My seats → Receipts:",
    `${opts.appUrl}/me/receipts`,
    "",
  ];
  if (!opts.hasAccount) {
    lines.push("You have not yet added a bank account in the app — please do that on the same page so we can pay you.", "");
  }
  lines.push("Minhwa Association", "", "(This is an automatic confirmation. Reply to this email if something is wrong.)");
  return { subject: `Receipt received — ${opts.code}`, text: lines.join("\n") };
}
