import type { LedgerCategory, ReceiptReading } from "@/lib/claims";

/**
 * Read a receipt with Claude: shop, date, total, VAT, what was bought, what kind of paper it is.
 * Pictures and PDFs go in as they are (no OCR step of our own); HEIC and very large files are skipped
 * with a note, and the treasurer types the numbers.
 */

const API = "https://api.anthropic.com/v1/messages";
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const MAX_BYTES = 4_800_000;   // the API takes images up to 5 MB

export type ReadInput = {
  files: { bytes: Buffer; content_type: string | null; filename: string | null }[];
  subject: string | null;
  body_text: string | null;
  sender: string | null;
  categories: LedgerCategory[];
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } }
  | { type: "document"; source: { type: "base64"; media_type: "application/pdf"; data: string } };

export async function readReceipt(input: ReadInput): Promise<{ reading: ReceiptReading | null; note: string | null; raw?: unknown }> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { reading: null, note: "ANTHROPIC_API_KEY is not set — typed by hand" };

  const blocks: ContentBlock[] = [];
  const skipped: string[] = [];
  for (const f of input.files) {
    const ct = (f.content_type ?? "").toLowerCase().split(";")[0].trim();
    if (f.bytes.length > MAX_BYTES) { skipped.push(`${f.filename ?? "file"} is too large to read`); continue; }
    if (ct === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: f.bytes.toString("base64") } });
    else if (IMAGE_TYPES.has(ct)) blocks.push({ type: "image", source: { type: "base64", media_type: ct, data: f.bytes.toString("base64") } });
    else if (ct === "text/html" || ct === "text/plain") blocks.push({ type: "text", text: `E-mail body as received:\n${f.bytes.toString("utf8").slice(0, 12000)}` });
    else skipped.push(`${f.filename ?? "file"} (${ct || "unknown type"}) cannot be read here`);
  }
  const context = [
    input.subject ? `Subject: ${input.subject}` : null,
    input.sender ? `From: ${input.sender}` : null,
    input.body_text ? `Message:\n${input.body_text.slice(0, 4000)}` : null,
  ].filter(Boolean).join("\n");
  if (blocks.length === 0 && !input.body_text) return { reading: null, note: skipped.join("; ") || "nothing to read" };
  blocks.push({ type: "text", text: `${context || "(no message text)"}\n\nRead the receipt(s) above and record what they say.` });

  const cats = input.categories.filter((c) => c.active && c.kind === "expense").map((c) => `${c.code} = ${c.name} (BAS ${c.bas})`).join("; ");
  const system = [
    "You read receipts for the treasurer of a small Swedish nonprofit (an art association teaching Korean folk painting in Stockholm).",
    "A member paid for something for the association and sent the receipt; the treasurer will pay the member back.",
    "Record exactly what the receipt shows. Amounts as numbers without thousands separators; the date as YYYY-MM-DD; the currency as an ISO code (SEK, EUR, KRW…).",
    "receipt_kind: 'receipt' for a shop receipt or e-receipt with the items on it, 'card_slip' for a card terminal slip with only an amount, 'invoice', 'order_confirmation', otherwise 'other'.",
    "purpose: what the member says it was for, in one short line, taken from their message when they say so; otherwise your best short guess from the items, or null.",
    `category: the best fit among ${cats || "material"} — use 'material' for brushes, paper, paint, ink, glue and other painting supplies.`,
    "If several receipts are attached, record the first and mention the others in notes. If you cannot read a value, use null — never guess a number.",
  ].join(" ");

  const tool = {
    name: "record_reading",
    description: "Record what the receipt says.",
    input_schema: {
      type: "object",
      properties: {
        merchant: { type: ["string", "null"], description: "Shop or company name as printed" },
        purchased_on: { type: ["string", "null"], description: "YYYY-MM-DD" },
        total: { type: ["number", "null"], description: "Total paid" },
        currency: { type: ["string", "null"], description: "ISO currency code" },
        vat: { type: ["number", "null"], description: "VAT (moms) amount if printed" },
        items: { type: "array", items: { type: "string" }, description: "Up to 8 short item lines" },
        receipt_kind: { type: ["string", "null"], enum: ["receipt", "card_slip", "invoice", "order_confirmation", "other", null] },
        addressed_to: { type: ["string", "null"], description: "Buyer name if printed (invoices)" },
        purpose: { type: ["string", "null"] },
        category: { type: ["string", "null"], description: "ledger category code" },
        confidence: { type: ["number", "null"], description: "0–1, how sure you are about merchant, date and total" },
        notes: { type: ["string", "null"], description: "Anything the treasurer should know: unreadable parts, several receipts, foreign currency, not a real receipt" },
      },
      required: ["merchant", "purchased_on", "total", "currency", "vat", "items", "receipt_kind", "addressed_to", "purpose", "category", "confidence", "notes"],
    },
  };

  const res = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || "claude-sonnet-5",
      max_tokens: 800,
      system,
      tools: [tool],
      tool_choice: { type: "tool", name: "record_reading" },
      messages: [{ role: "user", content: blocks }],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { reading: null, note: `could not read the receipt (API ${res.status})${skipped.length ? "; " + skipped.join("; ") : ""}`, raw: body.slice(0, 500) };
  }
  const data = (await res.json()) as { content?: { type: string; name?: string; input?: Record<string, unknown> }[] };
  const call = data.content?.find((b) => b.type === "tool_use" && b.name === "record_reading");
  if (!call?.input) return { reading: null, note: "the reader returned nothing usable", raw: data };
  const r = call.input;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v.replace(",", "."))) ? Number(v.replace(",", ".")) : null);
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const date = str(r.purchased_on);
  const reading: ReceiptReading = {
    merchant: str(r.merchant),
    purchased_on: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    total: num(r.total),
    currency: str(r.currency)?.toUpperCase().slice(0, 3) ?? null,
    vat: num(r.vat),
    items: Array.isArray(r.items) ? (r.items as unknown[]).map(String).filter(Boolean).slice(0, 8) : [],
    receipt_kind: (["receipt", "card_slip", "invoice", "order_confirmation", "other"] as const).find((k) => k === r.receipt_kind) ?? null,
    addressed_to: str(r.addressed_to),
    purpose: str(r.purpose),
    category: input.categories.some((c) => c.code === r.category) ? String(r.category) : null,
    confidence: num(r.confidence),
    notes: str(r.notes),
  };
  const notes = [reading.notes, reading.receipt_kind === "card_slip" ? "card slip only — ask for the shop receipt" : null, ...skipped].filter(Boolean).join("; ");
  return { reading, note: notes || null, raw: data };
}
