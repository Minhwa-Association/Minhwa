import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { saveReceiptDrive } from "@/app/actions";
import { Chevron, Notice } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { fileUrl } from "@/lib/drive-links";
import { money, num, paidWith, RECEIPT_SELECT, swishPretty, type SalesReceipt } from "@/lib/receipts";

/**
 * /receipt/[id]            — a member's own receipt (kvitto), or any receipt for the treasurer / admin
 * /receipt/[id]?from=k     — came from Payments → Kvitton (treasurer) → goes back there
 * /receipt/[id]?from=pay&b=<bookingId> · from=pass&p=<passId> · from=order&o=<orderId> — back to that page
 */
export default async function ReceiptPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; ok?: string; from?: string; b?: string; p?: string; o?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { id } = await params;
  const { error, ok, from, b, p, o } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("sales_receipts").select(RECEIPT_SELECT).eq("id", id).maybeSingle();
  const r = data as SalesReceipt | null;
  if (!r) notFound();
  const mine = r.member_id === me.id;
  const treasurer = canUsePayments(me);
  if (!mine && !treasurer) notFound();

  const safe = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : null);
  const back = from === "k" && treasurer ? "/payments/kvitton"
    : from === "pay" && safe(b) ? `/pay/${safe(b)}`
    : from === "pass" && safe(p) ? `/pass/${safe(p)}`
    : from === "order" && safe(o) ? `/store/orders/${safe(o)}`
    : "/me/payments";
  const backLabel = from === "k" && treasurer ? "Kvitton" : from === "pay" ? "the seat" : from === "pass" ? "the pass" : from === "order" ? "the order" : "My payments";
  const here = `/receipt/${r.id}${from ? `?from=${from}${b ? `&b=${b}` : ""}${p ? `&p=${p}` : ""}${o ? `&o=${o}` : ""}` : ""}`;
  const voided = !!r.voided_at;
  const swish = num(r.swish_sek), credit = num(r.credit_sek);
  const lines = Array.isArray(r.lines) && r.lines.length ? r.lines : [{ text: `${r.title} · ${r.description}`, amount_sek: num(r.total_sek) }];
  const addressLines = (r.org_address ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href={back} className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Back to {backLabel}</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{voided ? "Void receipt" : "Receipt"}</h1>
          <div className="muted">Kvitto {r.number}{voided ? " · annullerad" : ""} · {paidWith(r)}</div>
        </div>
        <Notice error={error} ok={ok} />
        {voided && (
          <div className="notice err">This receipt was made void {r.voided_at!.slice(0, 10)}{r.void_reason ? ` — ${r.void_reason}` : ""}. It is kept for the books; the number is not reused.{treasurer ? " If the payment is confirmed again, a new receipt is issued." : ""}</div>
        )}

        <div className={`card stack kvitto ${voided ? "void" : ""}`} style={{ gap: 14, padding: 18 }}>
          <div className="row between" style={{ alignItems: "flex-start", gap: 12 }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 17 }}>{r.org_name}</div>
              <div className="muted small">
                {r.org_number && <div>Org.nr {r.org_number}</div>}
                {addressLines.map((l, i) => <div key={i}>{l}</div>)}
                {r.org_email && <div>{r.org_email}</div>}
                {r.swish_number && <div>Swish {swishPretty(r.swish_number)}</div>}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontFamily: "Fraunces, Georgia, serif", fontWeight: 600, fontSize: 22 }}>KVITTO</div>
              <div className="muted small">Receipt</div>
            </div>
          </div>
          <div className="divider" />
          <div className="kv"><span className="k">Receipt no.</span><span className="v"><b>{r.number}</b></span></div>
          <div className="kv"><span className="k">Date</span><span className="v">{r.paid_on}</span></div>
          {r.payment_code && <div className="kv"><span className="k">Payment code</span><span className="v"><span className="tag code">{r.payment_code}</span></span></div>}
          <div className="kv"><span className="k">Paid by</span><span className="v">{r.member_name}</span></div>
          <div className="divider" />
          {lines.map((l, i) => (
            <div key={i} className="kv" style={{ alignItems: "flex-start" }}><span className="v" style={{ flex: 1, textAlign: "left" }}>{l.text}</span><span className="v" style={{ whiteSpace: "nowrap", marginLeft: 12 }}>{money(l.amount_sek)}</span></div>
          ))}
          <div className="divider" />
          <div className="kv"><span className="k" style={{ fontWeight: 700, color: "var(--ink)" }}>Total</span><span className="amount">{money(r.total_sek)}</span></div>
          {swish > 0 && <div className="kv"><span className="k">Swish</span><span className="v">{money(swish)} · {r.paid_on}</span></div>}
          {credit > 0 && (
            <>
              <div className="kv"><span className="k">Credits</span><span className="v">{money(credit)} · {r.paid_on}</span></div>
              <div className="muted small">1 credit = 1 kr. Credits are what the association owed you{r.credit_source ? ` — ${r.credit_source}` : ""}.</div>
            </>
          )}
          {r.note && <div className="muted small">{r.note}</div>}
          <div className="muted small">Issued {r.issued_at.slice(0, 10)} by app.minhwa.org</div>
        </div>

        {treasurer && (
          <div className="card stack" style={{ gap: 10, padding: "14px 18px" }}>
            <div className="muted small bold">Treasurer</div>
            <div className="small">
              {r.drive_file_id
                ? <>In the association&apos;s Drive since {r.drive_saved_at?.slice(0, 10) ?? "—"}{voided && r.drive_saved_at && r.voided_at! > r.drive_saved_at ? <span className="err-text"> · the copy there does not show the void yet</span> : null}.</>
                : <>Not in the association&apos;s Drive yet.</>}
              {" "}{r.title} · {r.description}{!mine ? ` · ${r.member_name}` : ""}
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {r.drive_file_id && <a href={fileUrl(r.drive_file_id)} target="_blank" rel="noopener noreferrer" className="btn line sm">Open in Drive</a>}
              <form action={saveReceiptDrive}>
                <input type="hidden" name="receipt_id" value={r.id} />
                <input type="hidden" name="back" value={here} />
                <SubmitButton className="btn line sm" pendingText="Saving…">{r.drive_file_id ? "Save to Drive again" : "Save to Drive"}</SubmitButton>
              </form>
            </div>
          </div>
        )}
      </div>

      <div className="footer">
        <a href={`/api/receipt/${r.id}/pdf`} className="btn ink" target="_blank" rel="noopener noreferrer">Open PDF</a>
        <a href={`/api/receipt/${r.id}/pdf?download=1`} className="btn line">Download PDF</a>
        <Link href={back} className="btn quiet">Back to {backLabel}</Link>
      </div>
    </main>
  );
}
