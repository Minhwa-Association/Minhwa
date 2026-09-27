import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { RECEIPTS_BUCKET, RECEIPT_ADDRESS, type ClaimFile, type ClaimRow, type LedgerCategory } from "@/lib/claims";
import { findClaimsInBank } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { ApprovedClaim, DoneClaim, NewClaim, type FileLink, type OutgoingLine } from "./ClaimCards";

type Q = { error?: string; ok?: string; n?: string; note?: string };

function Count({ n }: { n: number }) {
  return <span className={`count ${n === 0 ? "zero" : ""}`}>{n}</span>;
}

function okText(q: Q): string | undefined {
  if (q.ok === "looked") return Number(q.n ?? 0) > 0 ? `${q.n} transfer${q.n === "1" ? "" : "s"} found in the bank lines — check and tick below.` : "No matching transfer among the bank lines imported so far.";
  if (q.ok === "reread") return `Read again${q.note ? ` — ${q.note}` : "."}`;
  if (q.ok === "reread_failed") return `Could not read it${q.note ? `: ${q.note}` : "."} Type the values by hand.`;
  if (q.ok === "saved") return "Saved.";
  return undefined;
}

export default async function ReceiptsPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  const q = await searchParams;
  const supabase = await createClient();

  const [{ data: claimRows }, { data: memberRows }, { data: catRows }] = await Promise.all([
    supabase.from("claims_view").select("*").order("received_at", { ascending: false }).limit(300),
    supabase.from("members").select("id, name").eq("active", true).order("name"),
    supabase.from("ledger_categories").select("*").order("sort"),
  ]);
  const claims = (claimRows ?? []) as ClaimRow[];
  const members = (memberRows ?? []) as { id: string; name: string }[];
  const categories = (catRows ?? []) as LedgerCategory[];

  const fresh = claims.filter((c) => c.status === "new");
  const approved = claims.filter((c) => c.status === "approved");
  const paid = claims.filter((c) => c.status === "paid").slice(0, 25);
  const declined = claims.filter((c) => c.status === "declined");

  // files of the claims shown with pictures, with links that work for an hour
  const shown = [...fresh, ...approved];
  const filesByClaim = new Map<string, FileLink[]>();
  if (shown.length > 0) {
    const { data: fileRows } = await supabase.from("claim_files").select("*").in("claim_id", shown.map((c) => c.id)).order("sort");
    const files = (fileRows ?? []) as ClaimFile[];
    const { data: signed } = files.length > 0 ? await supabase.storage.from(RECEIPTS_BUCKET).createSignedUrls(files.map((f) => f.path), 3600) : { data: null };
    const urlByPath = new Map<string, string>();
    for (const s of signed ?? []) if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
    for (const f of files) {
      const list = filesByClaim.get(f.claim_id) ?? [];
      list.push({ ...f, url: urlByPath.get(f.path) ?? null });
      filesByClaim.set(f.claim_id, list);
    }
  }

  // outgoing bank lines not yet tied to anything — offered as "that line" for approved claims
  let lines: OutgoingLine[] = [];
  if (approved.length > 0) {
    const { data: txRows } = await supabase.from("bank_transactions").select("id, booked_on, amount_sek, counterparty, message, title")
      .eq("status", "outgoing").is("claim_id", null).is("payment_id", null).order("booked_on", { ascending: false }).limit(200);
    lines = (txRows ?? []) as OutgoingLine[];
  }

  const missing = ["RESEND_API_KEY", "RESEND_WEBHOOK_SECRET", "ANTHROPIC_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "MAIL_FROM"].filter((k) => !process.env[k]);

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Receipts</h1><div className="muted small">Members&apos; receipts for things they paid for the association → pay back from the bank · Treasurer and Admin</div></div>
        <TopNav current="payments" me={me} />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Notice error={q.error} ok={q.ok} text={okText(q)} />
        {missing.length > 0 && <div className="notice">Setup not finished — missing in Vercel: <span className="mono">{missing.join(", ")}</span>. Mails are not taken in until these are set (see README).</div>}

        <details className="card paysect" style={{ padding: 14 }}>
          <summary className="muted small" style={{ cursor: "pointer" }}>How it works</summary>
          <div className="small stack" style={{ gap: 6, marginTop: 8 }}>
            <div>1. A member mails the receipt to <b>{RECEIPT_ADDRESS}</b> (or uploads it under My seats → Receipts). It lands here within a minute, the member gets one automatic &ldquo;received&rdquo; reply, and the receipt is read for shop, date and total.</div>
            <div>2. You check the numbers, fix the amount to pay back and <b>Approve</b> (or Decline with a reply). Mails from an unknown address wait until you say who it is — once linked, that address is remembered.</div>
            <div>3. Pay from Nordea to the account shown, with the claim code in the message. When you paste the statement in Payments, the transfer is found and offered here — tick <b>Paid</b>. The receipt file, your decision and the bank line together are the record for the books.</div>
            <div className="muted">Members are asked to send shop receipts (not card slips), one receipt per mail, with a line on what it was for.</div>
          </div>
        </details>

        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>To check <Count n={fresh.length} /></h2>
          {fresh.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Nothing new. Receipts mailed to {RECEIPT_ADDRESS} show up here.</div>}
          {fresh.map((c) => <NewClaim key={c.id} c={c} files={filesByClaim.get(c.id) ?? []} members={members} categories={categories} />)}
        </section>

        <section className="card stack paysect" style={{ padding: 18 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2>Approved — to pay <Count n={approved.length} /></h2>
            {approved.length > 0 && <form action={findClaimsInBank}><button className="btn line sm" title="Look for the transfers among the bank lines already imported">Look in the bank</button></form>}
          </div>
          <div className="muted small">Transfer the amount from Nordea to the member&apos;s account with the claim code as message. Paste the statement in <Link href="/payments" style={{ fontWeight: 600 }}>Payments</Link> and the line is offered here; or tick &ldquo;Paid by hand&rdquo;.</div>
          {approved.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Nothing to pay.</div>}
          {approved.map((c) => <ApprovedClaim key={c.id} c={c} files={filesByClaim.get(c.id) ?? []} lines={lines} />)}
        </section>

        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>Paid recently <Count n={paid.length} /></h2>
          {paid.length === 0 && <div className="muted small">Nothing paid yet.</div>}
          {paid.map((c) => <DoneClaim key={c.id} c={c} />)}
        </section>

        {declined.length > 0 && (
          <details className="card paysect" style={{ padding: 18 }}>
            <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Declined <Count n={declined.length} /></h2></summary>
            <div className="stack" style={{ gap: 4, marginTop: 8 }}>{declined.map((c) => <DoneClaim key={c.id} c={c} />)}</div>
          </details>
        )}
      </div>
    </main>
  );
}
