import { createHash, randomUUID } from "node:crypto";
import { createServiceClient, type ServiceClient } from "@/lib/supabase/service";
import { fetchAttachment, fetchReceivedEmail, htmlToText, parseAddress, sendMail } from "@/lib/mail/resend";
import { readReceipt } from "@/lib/claims-read";
import { RECEIPTS_BUCKET, ackMail, claimSummary, isReceiptFile, safeFileName, type ClaimRow, type LedgerCategory } from "@/lib/claims";

/**
 * From an e-mail to a claim, in two steps:
 *   1. ingestInboundEmail — fetch the mail from Resend, keep the receipt files in the private bucket,
 *      create the claim (import_claim links the member by the sending address). Quick; safe to repeat.
 *   2. finishClaim — read the receipt with Claude, store the reading, send the one automatic reply
 *      ("received") when the sender is a known member. Runs after the webhook has been answered.
 * The same finishClaim serves receipts a member uploads in the app (without the reply).
 */

export type IngestResult = { claimId: string; code: string; created: boolean; memberId: string | null; files: number };

type StoredFile = { path: string; filename: string | null; content_type: string | null; bytes: number; sha256: string; sort: number };

function extFor(contentType: string | null | undefined, filename: string | null | undefined): string {
  const fromName = (filename ?? "").match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase();
  if (fromName) return `.${fromName}`;
  const ct = (contentType ?? "").toLowerCase();
  if (ct === "image/jpeg") return ".jpg";
  if (ct === "image/png") return ".png";
  if (ct === "image/webp") return ".webp";
  if (ct === "image/heic") return ".heic";
  if (ct === "application/pdf") return ".pdf";
  if (ct === "text/html") return ".html";
  return "";
}

async function storeFile(supabase: ServiceClient, claimId: string, n: number, bytes: Buffer, contentType: string | null, filename: string | null): Promise<StoredFile> {
  const ext = extFor(contentType, filename);
  const base = safeFileName(filename?.replace(/\.[a-z0-9]{2,5}$/i, ""), `receipt-${n}`);
  const path = `${claimId}/${n}-${base}${ext}`;
  const { error } = await supabase.storage.from(RECEIPTS_BUCKET).upload(path, bytes, { contentType: contentType ?? "application/octet-stream", upsert: true });
  if (error) throw new Error(`storing ${path}: ${error.message}`);
  return { path, filename, content_type: contentType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), sort: n };
}

/** Step 1 — the webhook's email id → a claim with its files. */
export async function ingestInboundEmail(emailId: string): Promise<IngestResult> {
  const supabase = createServiceClient();
  const mail = await fetchReceivedEmail(emailId);
  const messageId = mail.message_id?.trim() || `resend:${mail.id}`;

  const { data: existing } = await supabase.from("expense_claims").select("id, code, member_id").eq("message_id", messageId).maybeSingle();
  if (existing) return { claimId: existing.id, code: existing.code, created: false, memberId: existing.member_id, files: 0 };

  const fromHeader = parseAddress(mail.headers?.from ?? mail.headers?.From);
  const fromPlain = parseAddress(mail.from);
  const senderEmail = fromHeader.email ?? fromPlain.email;
  const senderName = fromHeader.name ?? fromPlain.name;
  const bodyText = (mail.text?.trim() || (mail.html ? htmlToText(mail.html) : "")).slice(0, 8000) || null;

  const claimId = randomUUID();
  const files: StoredFile[] = [];
  const picks = (mail.attachments ?? []).filter((a) => isReceiptFile(a.content_type, a.filename, a.size ?? null, a.content_disposition === "inline")).slice(0, 6);
  for (const a of picks) {
    const { bytes, meta } = await fetchAttachment(mail.id, a.id);
    files.push(await storeFile(supabase, claimId, files.length + 1, bytes, meta.content_type ?? a.content_type, meta.filename ?? a.filename));
  }
  // an e-receipt that is the mail itself (no attachment) — keep the mail as the receipt
  if (files.length === 0 && mail.html) {
    files.push(await storeFile(supabase, claimId, 1, Buffer.from(mail.html, "utf8"), "text/html", "mail.html"));
  }

  const { data, error } = await supabase.rpc("import_claim", {
    p: { id: claimId, message_id: messageId, sender_email: senderEmail, sender_name: senderName, subject: mail.subject, body_text: bodyText, received_at: mail.created_at, source: "email", files },
  });
  if (error) throw new Error(`import_claim: ${error.message}`);
  const r = data as { claim_id: string; code: string; created: boolean; member_id: string | null };
  return { claimId: r.claim_id, code: r.code, created: r.created, memberId: r.member_id, files: files.length };
}

/** Step 2 — read the receipt and store the reading; then the "received" reply, once, to a known member. */
export async function finishClaim(claimId: string, opts: { sendAck: boolean; force?: boolean }): Promise<{ read: boolean; acked: boolean; note: string | null }> {
  const supabase = createServiceClient();
  const [{ data: claim }, { data: files }, { data: cats }] = await Promise.all([
    supabase.from("claims_view").select("*").eq("id", claimId).single(),
    supabase.from("claim_files").select("path, filename, content_type").eq("claim_id", claimId).order("sort"),
    supabase.from("ledger_categories").select("*").order("sort"),
  ]);
  if (!claim) throw new Error("claim not found");
  const c = claim as ClaimRow;

  let read = false;
  let note: string | null = null;
  if (opts.force || !c.read_at) {
    const downloaded: { bytes: Buffer; content_type: string | null; filename: string | null }[] = [];
    for (const f of files ?? []) {
      const { data } = await supabase.storage.from(RECEIPTS_BUCKET).download(f.path);
      if (data) downloaded.push({ bytes: Buffer.from(await data.arrayBuffer()), content_type: f.content_type, filename: f.filename });
    }
    const result = await readReceipt({ files: downloaded, subject: c.subject, body_text: c.body_text, sender: c.sender_name ?? c.sender_email, categories: (cats ?? []) as LedgerCategory[] });
    note = result.note;
    const r = result.reading;
    const isSek = !r?.currency || r.currency === "SEK";
    const { error } = await supabase.rpc("set_claim_reading", {
      p_claim_id: claimId,
      p: {
        merchant: r?.merchant ?? null,
        purchased_on: r?.purchased_on ?? null,
        receipt_total: r?.total ?? null,
        receipt_currency: r?.currency ?? (r?.total != null ? "SEK" : null),
        amount_sek: r && isSek ? r.total : null,
        vat_sek: r && isSek ? r.vat : null,
        purpose: r?.purpose ?? null,
        category_code: r?.category ?? null,
        ai_json: r ? { ...r, model: process.env.CLAUDE_MODEL || "claude-sonnet-5", read_at: new Date().toISOString() } : null,
        ai_note: note,
        force: !!opts.force,
      },
    });
    if (error) throw new Error(`set_claim_reading: ${error.message}`);
    read = !!r;
  }

  let acked = false;
  if (opts.sendAck && c.member_id && c.sender_email && !c.acked_at) {
    const { data: fresh } = await supabase.from("claims_view").select("*").eq("id", claimId).single();
    const f = (fresh ?? c) as ClaimRow;
    const mail = ackMail({
      memberName: f.member_name ?? "there",
      code: f.code,
      summary: claimSummary(f),
      appUrl: (process.env.APP_URL ?? "https://app.minhwa.org").replace(/\/$/, ""),
      hasAccount: !!f.clearing,
    });
    await sendMail({ to: c.sender_email, subject: mail.subject, text: mail.text });
    await supabase.rpc("mark_claim_acked", { p_claim_id: claimId });
    acked = true;
  }
  return { read, acked, note };
}
