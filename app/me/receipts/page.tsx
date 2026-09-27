import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { roleLabels } from "@/lib/roles";
import { shortDate } from "@/lib/dates";
import { CLAIM_STATUS_LABEL, RECEIPT_ADDRESS, claimClass, claimSummary, formatAccount, sek, type BankAccount, type ClaimRow } from "@/lib/claims";
import { saveBankAccount, saveMyEmails, withdrawReceiptClaim } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { ReceiptUploader } from "./ReceiptUploader";

export default async function MyReceiptsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: claimRows }, { data: account }, { data: mine }] = await Promise.all([
    supabase.from("claims_view").select("*").eq("member_id", me.id).order("received_at", { ascending: false }).limit(50),
    supabase.from("member_bank_accounts").select("*").eq("member_id", me.id).maybeSingle(),
    supabase.from("members").select("email, extra_emails").eq("id", me.id).single(),
  ]);
  const claims = (claimRows ?? []) as ClaimRow[];
  const acct = (account ?? null) as BankAccount | null;
  const addresses = [mine?.email, ...((mine?.extra_emails as string[] | null) ?? [])].filter(Boolean) as string[];

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Receipts</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
        <TopNav current="me" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Notice error={error} ok={ok} />
        <div className="muted small">Paid for something for the association yourself? Send the receipt and the treasurer pays you back to your bank account. <Link href="/me" style={{ fontWeight: 600 }}>← My seats</Link></div>

        <section className="card stack" style={{ padding: 18 }}>
          <h2>Send a receipt</h2>
          <div className="small">
            <b>By e-mail:</b> send the picture or PDF to <b>{RECEIPT_ADDRESS}</b> — one receipt per mail, with a line on what it was for.
            {addresses.length > 0
              ? <> Send it from <b>{addresses.join(", ")}</b> so it is filed as yours.</>
              : <> <span className="err-text">No e-mail address is registered for you yet</span> — add the address you will send from below, or upload here instead.</>}
          </div>
          <details>
            <summary className="muted small" style={{ cursor: "pointer" }}>Addresses you send from</summary>
            <form action={saveMyEmails} className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 6 }}>
              <input name="emails" defaultValue={((mine?.extra_emails as string[] | null) ?? []).join(", ")} placeholder="other addresses, comma-separated" style={{ flex: "1 1 220px" }} />
              <button className="btn line sm">Save</button>
            </form>
            {mine?.email && <div className="muted small" style={{ marginTop: 4 }}>{mine.email} is your registered address (the admin changes that one).</div>}
          </details>
          <div className="small" style={{ marginTop: 6 }}><b>Or upload it here:</b> a shop receipt (not just the card slip), clearly readable.</div>
          <ReceiptUploader />
        </section>

        <section className="card stack" style={{ padding: 18 }}>
          <h2>Your bank account</h2>
          <div className="muted small">Where we pay you back. Only you and the treasurer can see it.{acct ? <> Saved: <b>{formatAccount(acct.clearing, acct.account)}</b>{acct.bank ? ` · ${acct.bank}` : ""}{acct.holder ? ` · ${acct.holder}` : ""}</> : null}</div>
          <form action={saveBankAccount} className="cform">
            <label>Clearing number<input name="clearing" defaultValue={acct?.clearing ?? ""} placeholder="4 digits (5 for Swedbank)" inputMode="numeric" required /></label>
            <label>Account number<input name="account" defaultValue={acct?.account ?? ""} placeholder="digits only" inputMode="numeric" required /></label>
            <label>Bank<input name="bank" defaultValue={acct?.bank ?? ""} placeholder="optional" /></label>
            <label>Name on the account<input name="holder" defaultValue={acct?.holder ?? ""} placeholder={`optional — if not ${me.name}`} /></label>
            <div className="cbtns"><button className="btn ink sm">{acct ? "Update" : "Save"}</button></div>
          </form>
        </section>

        <section className="card stack" style={{ padding: 18 }}>
          <h2>Your receipts</h2>
          {claims.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Nothing sent yet.</div>}
          {claims.map((c) => (
            <div key={c.id} className={`txrow ${claimClass(c.status)}`} style={{ gridTemplateColumns: "44px minmax(0, 1fr) auto" }}>
              <div className="muted small">{shortDate(new Date(c.received_at))}</div>
              <div style={{ minWidth: 0 }}>
                <b>{claimSummary({ ...c, approved_amount_sek: null }) || c.subject || "Receipt"}</b> <span className="tag code">{c.code}</span>
                <div className="muted small">
                  {c.purpose ?? ""}{c.status === "approved" && c.approved_amount_sek != null ? ` · ${sek(c.approved_amount_sek)} on its way` : ""}{c.status === "paid" ? ` · ${sek(c.approved_amount_sek)} paid${c.paid_at ? ` ${shortDate(new Date(c.paid_at + "T00:00:00"))}` : ""}` : ""}
                  {c.reply ? <div>&ldquo;{c.reply}&rdquo;</div> : null}
                </div>
              </div>
              <div className="actions" style={{ gridColumn: "auto", alignItems: "center" }}>
                <span className={`tag ${claimClass(c.status) || "pending"}`}>{CLAIM_STATUS_LABEL[c.status]}</span>
                {c.status === "new" && <form action={withdrawReceiptClaim}><input type="hidden" name="claim_id" value={c.id} /><button className="btn quiet sm">Take back</button></form>}
              </div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
