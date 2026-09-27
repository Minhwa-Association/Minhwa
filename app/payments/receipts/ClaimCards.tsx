import Link from "next/link";
import { shortDate } from "@/lib/dates";
import { bankDate } from "@/lib/payments";
import { CLAIM_STATUS_LABEL, claimSummary, formatAccount, receiptMoney, sek, type ClaimFile, type ClaimRow, type LedgerCategory } from "@/lib/claims";
import { decideClaim, linkClaimMember, markClaimPaid, rejectClaimSuggestion, reopenClaim, rereadClaim, sendClaimAck, unpayClaim } from "@/app/actions";

export type FileLink = ClaimFile & { url: string | null };
export type OutgoingLine = { id: string; booked_on: string; amount_sek: number | string; counterparty: string | null; message: string | null; title: string };

function isImage(ct: string | null | undefined) { return (ct ?? "").startsWith("image/"); }

/** The pictures / PDFs of one claim — a thumbnail row that opens the full file */
export function Files({ files }: { files: FileLink[] }) {
  if (files.length === 0) return <div className="muted small">No file — the receipt was in the mail text.</div>;
  return (
    <div className="cfiles">
      {files.map((f) => (
        <a key={f.id} href={f.url ?? "#"} target="_blank" rel="noopener noreferrer" className="cfile" title={f.filename ?? f.path}>
          {isImage(f.content_type) && f.url ? <img src={f.url} alt={f.filename ?? "receipt"} loading="lazy" /> : <span className="cdoc">{(f.content_type ?? "").includes("pdf") ? "PDF" : (f.content_type ?? "").includes("html") ? "MAIL" : "FILE"}</span>}
        </a>
      ))}
    </div>
  );
}

function Who({ c }: { c: ClaimRow }) {
  return (
    <div>
      <b>{c.member_name ?? "Unknown sender"}</b>
      <span className="muted small"> · {c.sender_name && c.sender_name !== c.member_name ? `${c.sender_name} · ` : ""}{c.sender_email ?? (c.source === "app" ? "uploaded in the app" : "no address")} · {shortDate(new Date(c.received_at))}</span>
      {" "}<span className="tag code">{c.code}</span>
      {c.duplicate_of && <span className="tag pending" style={{ marginLeft: 6 }}>same as {c.duplicate_code ?? "another claim"}?</span>}
    </div>
  );
}

function Mail({ c }: { c: ClaimRow }) {
  if (!c.subject && !c.body_text) return null;
  const long = (c.body_text ?? "").length > 240;
  return (
    <div className="small" style={{ marginTop: 4 }}>
      {c.subject && c.subject !== "Uploaded in the app" && <div><b>{c.subject}</b></div>}
      {c.body_text && (long
        ? <details><summary className="muted" style={{ cursor: "pointer" }}>{c.body_text.slice(0, 160)}…</summary><div className="prewrap muted" style={{ marginTop: 4 }}>{c.body_text}</div></details>
        : <div className="prewrap muted">{c.body_text}</div>)}
    </div>
  );
}

function Reading({ c }: { c: ClaimRow }) {
  const items = Array.isArray(c.ai_json?.items) ? (c.ai_json!.items as string[]) : [];
  if (!c.read_at) return <div className="muted small">Not read yet.</div>;
  return (
    <div className="small muted">
      {items.length > 0 && <div>Read: {items.slice(0, 6).join(" · ")}</div>}
      {c.ai_note && <div className="err-text">⚠ {c.ai_note}</div>}
    </div>
  );
}

/** A claim still to check: what came in, what was read, the treasurer's form */
export function NewClaim({ c, files, members, categories }: { c: ClaimRow; files: FileLink[]; members: { id: string; name: string }[]; categories: LedgerCategory[] }) {
  const expense = categories.filter((k) => k.active && k.kind !== "income");
  return (
    <div className="claim">
      <Files files={files} />
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <Who c={c} />
        <Mail c={c} />
        <Reading c={c} />
        {!c.member_id && (
          <form action={linkClaimMember} className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            <input type="hidden" name="claim_id" value={c.id} />
            <span className="small"><b>Who is this?</b></span>
            <select name="member_id" className="inline" defaultValue="" required aria-label="Member">
              <option value="">— pick the member —</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
            <label className="small row" style={{ gap: 4, alignItems: "center", margin: 0 }}><input type="checkbox" name="remember" defaultChecked style={{ width: "auto", minHeight: 0 }} /> remember this address</label>
            <button className="btn line sm">Link</button>
          </form>
        )}
        <form action={decideClaim} className="cform">
          <input type="hidden" name="claim_id" value={c.id} />
          <label>Shop<input name="merchant" defaultValue={c.merchant ?? ""} placeholder="as printed" /></label>
          <label>Date<input name="purchased_on" defaultValue={c.purchased_on ?? ""} placeholder="YYYY-MM-DD" inputMode="numeric" /></label>
          <label>Receipt total<input name="receipt_total" defaultValue={c.receipt_total != null ? String(c.receipt_total) : ""} inputMode="decimal" /></label>
          <label>Currency<input name="receipt_currency" defaultValue={c.receipt_currency ?? "SEK"} maxLength={3} style={{ textTransform: "uppercase" }} /></label>
          <label className="strong">Pay back, kr<input name="amount_sek" defaultValue={c.amount_sek != null ? String(c.amount_sek) : ""} inputMode="decimal" placeholder="kr" /></label>
          <label>VAT, kr<input name="vat_sek" defaultValue={c.vat_sek != null ? String(c.vat_sek) : ""} inputMode="decimal" /></label>
          <label className="wide">For<input name="purpose" defaultValue={c.purpose ?? ""} placeholder="what it was for" /></label>
          <label>Category<select name="category_code" defaultValue={c.category_code ?? "material"}>{expense.map((k) => <option key={k.code} value={k.code}>{k.name} · {k.bas}</option>)}</select></label>
          <label className="wide">Reply to the member<input name="reply" defaultValue={c.reply ?? ""} placeholder="optional — shown in the app (reason when declining)" /></label>
          <label className="wide">Your note<input name="note" defaultValue={c.note ?? ""} placeholder="optional — only you see it" /></label>
          {c.duplicate_of && <label className="wide row" style={{ gap: 6, alignItems: "center" }}><input type="checkbox" name="not_duplicate" style={{ width: "auto", minHeight: 0 }} /> <span className="small">Not a duplicate — a different purchase</span></label>}
          <div className="cbtns">
            <button className="btn ink sm" name="do" value="approve" disabled={!c.member_id} title={c.member_id ? "Approve and fix the amount to pay" : "Say who the member is first"}>Approve</button>
            <button className="btn line sm" name="do" value="save">Save</button>
            <button className="btn quiet sm" name="do" value="decline">Decline</button>
          </div>
        </form>
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <form action={rereadClaim}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm" title="Read the receipt again with the reader (overwrites the reading)">Read again</button></form>
          {c.member_id && c.sender_email && !c.acked_at && (
            <form action={sendClaimAck}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm" title="Send the automatic 'received' reply now">Send &ldquo;received&rdquo; reply</button></form>
          )}
        </div>
      </div>
    </div>
  );
}

/** Approved: pay from the bank, then tick */
export function ApprovedClaim({ c, files, lines }: { c: ClaimRow; files: FileLink[]; lines: OutgoingLine[] }) {
  const sameAmount = lines.filter((l) => Math.abs(Number(l.amount_sek)) === Number(c.approved_amount_sek) && l.id !== c.suggested_tx_id);
  return (
    <div className="claim">
      <Files files={files} />
      <div className="stack" style={{ gap: 8, minWidth: 0 }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
          <Who c={c} />
          <div className="amt">{sek(c.approved_amount_sek)}</div>
        </div>
        <div className="small muted">{claimSummary({ ...c, approved_amount_sek: null, amount_sek: null })}{c.purpose ? ` · ${c.purpose}` : ""} · {c.category_name ?? "Material"} {c.category_bas ? `(${c.category_bas})` : ""}</div>
        <div className="payout">
          <div><span className="muted small">Pay to</span><br /><b>{c.account_holder ?? c.member_name}</b></div>
          <div><span className="muted small">Account</span><br />{c.clearing ? <b className="mono">{formatAccount(c.clearing, c.account)}</b> : <span className="err-text">No bank account in the app yet — ask the member to add it under My seats → Receipts.</span>}{c.account_bank ? <span className="muted small"> · {c.account_bank}</span> : null}</div>
          <div><span className="muted small">Message</span><br /><b className="mono">{c.code} Minhwa</b></div>
        </div>
        {c.suggested_tx_id && (
          <div className="sugg">
            <div className="small"><b>In the bank:</b> {bankDate(c.suggested_date!)} · {c.suggested_name ?? "—"}{c.suggested_message ? ` · ${c.suggested_message}` : ""} · <b>{sek(Math.abs(Number(c.suggested_amount)))}</b></div>
            <div className="row" style={{ gap: 6 }}>
              <form action={markClaimPaid}><input type="hidden" name="claim_id" value={c.id} /><input type="hidden" name="tx_id" value={c.suggested_tx_id} /><button className="btn ink sm">Paid — this line</button></form>
              <form action={rejectClaimSuggestion}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm">Not this one</button></form>
            </div>
          </div>
        )}
        <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }}>
          {sameAmount.length > 0 && (
            <form action={markClaimPaid} className="row" style={{ gap: 6, alignItems: "center" }}>
              <input type="hidden" name="claim_id" value={c.id} />
              <select name="tx_id" className="inline" defaultValue={sameAmount[0].id} aria-label="Bank line">
                {sameAmount.map((l) => <option key={l.id} value={l.id}>{bankDate(l.booked_on)} · {l.counterparty ?? l.title}{l.message ? ` · ${l.message}` : ""}</option>)}
              </select>
              <button className="btn line sm">Paid — that line</button>
            </form>
          )}
          <form action={markClaimPaid} className="row" style={{ gap: 6, alignItems: "center" }}>
            <input type="hidden" name="claim_id" value={c.id} />
            <input name="paid_on" placeholder="YYYY-MM-DD" inputMode="numeric" style={{ width: 120, minHeight: 36, padding: "4px 8px", fontSize: 13 }} aria-label="Paid on" />
            <button className="btn line sm" title="Mark as paid without a bank line (the date is optional — today if empty)">Paid by hand</button>
          </form>
          <form action={reopenClaim}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm">Back to checking</button></form>
        </div>
      </div>
    </div>
  );
}

/** Paid / declined rows */
export function DoneClaim({ c }: { c: ClaimRow }) {
  return (
    <div className="txrow" style={{ gridTemplateColumns: "44px minmax(0, 1fr) auto" }}>
      <div className="muted small">{c.paid_at ? bankDate(c.paid_at) : c.reviewed_at ? shortDate(new Date(c.reviewed_at)) : ""}</div>
      <div style={{ minWidth: 0 }}>
        <b>{c.member_name ?? c.sender_email ?? "Unknown"}</b> <span className="tag code">{c.code}</span>
        <div className="muted small">{claimSummary({ ...c, approved_amount_sek: null, amount_sek: null }) || (c.receipt_total != null ? receiptMoney(c.receipt_total, c.receipt_currency) : "")}{c.purpose ? ` · ${c.purpose}` : ""}{c.status === "paid" ? ` · ${c.bank_name ? `bank: ${c.bank_name}` : "by hand"}` : ""}{c.reply ? ` · “${c.reply}”` : ""}</div>
      </div>
      <div className="actions" style={{ gridColumn: "auto", alignItems: "center" }}>
        {c.status === "paid" && <span className="amt" style={{ fontSize: 16 }}>{sek(c.approved_amount_sek)}</span>}
        <span className={`tag ${c.status === "paid" ? "paid" : "unpaid"}`}>{CLAIM_STATUS_LABEL[c.status]}</span>
        {c.status === "paid" && <form action={unpayClaim}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm">Undo</button></form>}
        {c.status === "declined" && <form action={reopenClaim}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm">Reopen</button></form>}
      </div>
    </div>
  );
}

export function BackToPayments() {
  return <Link href="/payments" className="btn line sm">← Payments</Link>;
}
