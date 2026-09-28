import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { shortDate } from "@/lib/dates";
import { attachTransaction, confirmMatched, confirmPayment, ignoreTransaction, importBank, rejectMatch, restoreTransaction, undoConfirmation } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { bankDate, bankWho, describePayment, kr, paymentLabel, type BankTx, type PaymentRow } from "@/lib/payments";
import { credits } from "@/lib/credits";

type Q = { error?: string; ok?: string; added?: string; dup?: string; matched?: string; sugg?: string; skipped?: string; n?: string; show?: string };

const TX_SELECT = "id, booked_on, amount_sek, title, counterparty, message, own_notes, balance_sek, status, payment_id, imported_at, payment:payments!bank_transactions_payment_id_fkey(id, code, note, amount_sek, status, kind, member:members(name))";

const PLACEHOLDER = [
  "Bokföringsdag,Belopp,Avsändare,Mottagare,Namn,Ytterligare detaljer,Meddelande,Egna anteckningar,Saldo,Valuta",
  "2026/10/05,100,SWISH INBETAL,,Inbetalning Swish Företag,,\"PARK,JISU\",,12345.6,SEK",
].join("\n");

function plural(n: number, word: string) { return `${n} ${word}${n === 1 ? "" : "s"}`; }

function okText(q: Q): string | undefined {
  if (q.ok === "imported") {
    const added = Number(q.added ?? 0), dup = Number(q.dup ?? 0), matched = Number(q.matched ?? 0), sugg = Number(q.sugg ?? 0), skipped = Number(q.skipped ?? 0);
    const parts = [`${plural(added, "new line")} added${dup ? ` (${dup} already there)` : ""}`];
    if (matched) parts.push(`${matched} matched by code`);
    if (sugg) parts.push(`${sugg} suggested`);
    if (skipped) parts.push(`${plural(skipped, "line")} couldn't be read`);
    return parts.join(" · ") + ".";
  }
  if (q.ok === "confirmed_all") return `${plural(Number(q.n ?? 0), "payment")} confirmed.`;
  return undefined;
}

function Count({ n }: { n: number }) {
  return <span className={`count ${n === 0 ? "zero" : ""}`}>{n}</span>;
}

function PayLine({ p }: { p: PaymentRow }) {
  return (
    <span>
      <b>{p.member_name ?? "Member"}</b>
      <span className="muted"> · {describePayment(p)}</span>
      {p.code && <> <span className="tag code">{p.code}</span></>}
      {Number(p.credit_sek ?? 0) > 0 && <span className="muted small"> · + {credits(p.credit_sek)}</span>}
    </span>
  );
}

export default async function PaymentsPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  const q = await searchParams;
  const showOther = q.show === "other";

  const supabase = await createClient();
  const [{ data: matchedRows }, { data: waitingRows }, { data: openRows }, { data: claimedRows }, { data: confirmedRows }, { count: nOut }, { count: nIgn }, otherRes, { count: nClaims }, { count: nToPay }, { data: creditRows }] = await Promise.all([
    supabase.from("bank_transactions").select(TX_SELECT).in("status", ["matched", "suggested"]).order("booked_on", { ascending: false }).order("imported_at", { ascending: false }),
    supabase.from("bank_transactions").select(TX_SELECT).eq("status", "unmatched").gt("amount_sek", 0).order("booked_on", { ascending: false }).order("imported_at", { ascending: false }),
    supabase.from("payments_view").select("*").in("status", ["pending", "claimed"]).is("bank_tx_id", null).order("member_name").order("created_at"),
    supabase.from("payments_view").select("*").eq("status", "claimed").is("bank_tx_id", null).order("claimed_at", { ascending: true, nullsFirst: false }),
    supabase.from("payments_view").select("*").eq("status", "confirmed").order("confirmed_at", { ascending: false, nullsFirst: false }).limit(15),
    supabase.from("bank_transactions").select("id", { count: "exact", head: true }).eq("status", "outgoing"),
    supabase.from("bank_transactions").select("id", { count: "exact", head: true }).eq("status", "ignored"),
    showOther
      ? supabase.from("bank_transactions").select(TX_SELECT).in("status", ["outgoing", "ignored"]).order("booked_on", { ascending: false }).limit(150)
      : Promise.resolve({ data: null }),
    supabase.from("expense_claims").select("id", { count: "exact", head: true }).eq("status", "new"),
    supabase.from("expense_claims").select("id", { count: "exact", head: true }).eq("status", "approved"),
    supabase.from("credit_balances").select("balance"),
  ]);
  const creditBalances = (creditRows ?? []) as { balance: number }[];
  const creditsOwed = creditBalances.reduce((s, b) => s + Number(b.balance), 0);
  const creditHolders = creditBalances.filter((b) => Number(b.balance) > 0).length;
  const matched = (matchedRows ?? []) as unknown as BankTx[];
  const waiting = (waitingRows ?? []) as unknown as BankTx[];
  const open = (openRows ?? []) as PaymentRow[];
  const claimed = (claimedRows ?? []) as PaymentRow[];
  const confirmed = (confirmedRows ?? []) as PaymentRow[];
  const other = ((otherRes as { data: BankTx[] | null }).data ?? []) as BankTx[];
  const pendingOnly = open.filter((p) => p.status === "pending");
  const byCode = matched.filter((t) => t.status === "matched").length;

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Payments</h1><div className="muted small">Nordea statement ↔ members&apos; Swish payments · Treasurer and Admin</div></div>
        <TopNav current="payments" me={me} />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Notice error={q.error} ok={q.ok} text={okText(q)} />

        <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
          <div className="small">
            <b>Receipts</b><span className="muted"> · members&apos; receipts to pay back (receipt@minhwa.org)</span>
            {" "}<span className={`count ${(nClaims ?? 0) === 0 ? "zero" : ""}`} title="to check">{nClaims ?? 0}</span>
            {(nToPay ?? 0) > 0 && <span className="muted small"> · {nToPay} approved, to pay</span>}
          </div>
          <Link href="/payments/receipts" className="btn line sm">Open Receipts</Link>
        </div>

        <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
          <div className="small">
            <b>Credits</b><span className="muted"> · for helping with activities, 1 credit = 1 kr</span>
            {creditHolders > 0 && <span className="muted small"> · {creditHolders === 1 ? "1 member holds" : `${creditHolders} members hold`} {credits(creditsOwed)}</span>}
          </div>
          <Link href="/payments/credits" className="btn line sm">Open Credits</Link>
        </div>

        {/* 1. paste */}
        <form action={importBank} className="card stack" style={{ padding: 18 }}>
          <h2>Paste the Nordea statement</h2>
          <div className="muted small">Nordea → the account → Transaktioner → Exportera (CSV), or select the rows in the web bank and copy. Paste everything, header included — lines already added are skipped, money going out is kept aside for the ledger. The bank shows the payer&apos;s name, not the Swish message, so a line is matched by amount, name and date.</div>
          <textarea name="rows" rows={5} placeholder={PLACEHOLDER} spellCheck={false} style={{ fontFamily: "ui-monospace, 'SF Mono', Menlo, monospace", fontSize: 13 }} />
          <div className="row" style={{ gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label htmlFor="file" className="muted small" style={{ margin: 0 }}>or the exported file:</label>
            <input id="file" name="file" type="file" accept=".csv,.txt,text/csv,text/plain" style={{ width: "auto", flexGrow: 1 }} />
            <button className="btn ink sm" style={{ minHeight: 44 }}>Add lines &amp; match</button>
          </div>
        </form>

        {/* 2. matched / suggested */}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2>Matched in the bank <Count n={matched.length} /></h2>
            {byCode > 0 && (
              <form action={confirmMatched}><button className="btn ink sm">Confirm {plural(byCode, "code match")}</button></form>
            )}
          </div>
          <div className="muted small">A payment code in the line = matched. Same amount, same name and a date within the window = suggested — check and confirm each one.</div>
          {matched.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Nothing waiting here.</div>}
          {matched.map((t) => {
            const w = bankWho(t);
            return (
            <div key={t.id} className="txrow">
              <div className="muted small">{bankDate(t.booked_on)}</div>
              <div style={{ minWidth: 0 }}>
                <div><b>{w.who}</b>{w.detail ? <span className="muted small"> · {w.detail}</span> : null}</div>
                <div className="small" style={{ marginTop: 4 }}>
                  <span className="arrow">→ </span>
                  {t.payment ? (
                    <>
                      <b>{t.payment.member?.name ?? "Member"}</b>
                      <span className="muted"> · {t.payment.note && t.payment.code && t.payment.note.startsWith(t.payment.code) ? t.payment.note.slice(t.payment.code.length).trim() : t.payment.note}</span>
                      {t.payment.code && <> <span className="tag code">{t.payment.code}</span></>}
                      <span className={`tag ${t.status === "matched" ? "paid" : "pending"}`} style={{ marginLeft: 6 }}>{t.status === "matched" ? "code match" : "suggested"}</span>
                    </>
                  ) : <span className="muted">payment missing</span>}
                </div>
              </div>
              <div className="amt">{kr(t.amount_sek)}</div>
              <div className="actions">
                <form action={confirmPayment}>
                  <input type="hidden" name="payment_id" value={t.payment_id ?? ""} />
                  <input type="hidden" name="tx_id" value={t.id} />
                  <button className="btn ink sm">Confirm</button>
                </form>
                <form action={rejectMatch}>
                  <input type="hidden" name="tx_id" value={t.id} />
                  <button className="btn quiet sm">Not this one</button>
                </form>
              </div>
            </div>
            );
          })}
        </section>

        {/* 3. claimed, not in the bank yet */}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>Waiting for confirmation <Count n={claimed.length} /></h2>
          <div className="muted small">The member tapped &ldquo;I have paid&rdquo; but no bank line matches yet — it usually shows up after the next statement paste. Confirm here only if you have seen the money some other way.</div>
          {claimed.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Nobody is waiting.</div>}
          {claimed.map((p) => (
            <div key={p.id} className="txrow">
              <div className="muted small">{p.claimed_at ? shortDate(new Date(p.claimed_at)) : "—"}</div>
              <div style={{ minWidth: 0 }}><PayLine p={p} /></div>
              <div className="amt">{kr(p.amount_sek)}</div>
              <div className="actions">
                <form action={confirmPayment}>
                  <input type="hidden" name="payment_id" value={p.id} />
                  <button className="btn line sm">Confirm without bank line</button>
                </form>
              </div>
            </div>
          ))}
        </section>

        {/* 4. only in the bank */}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>Only in the bank <Count n={waiting.length} /></h2>
          <div className="muted small">Money that came in without a match. Pick the payment it belongs to — the payer&apos;s bank name is remembered, so next time it is suggested by itself. Not a member payment? Set it aside.</div>
          {waiting.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Every incoming line is accounted for.</div>}
          {waiting.map((t) => {
            const sameAmount = open.filter((p) => Number(p.amount_sek) === Number(t.amount_sek));
            const others = open.filter((p) => Number(p.amount_sek) !== Number(t.amount_sek));
            const w = bankWho(t);
            return (
              <div key={t.id} className="txrow">
                <div className="muted small">{bankDate(t.booked_on)}</div>
                <div style={{ minWidth: 0 }}>
                  <div><b>{w.who}</b></div>
                  {w.detail && <div className="muted small">{w.detail}</div>}
                </div>
                <div className="amt">{kr(t.amount_sek)}</div>
                <div className="actions">
                  <form action={attachTransaction} className="row" style={{ gap: 6 }}>
                    <input type="hidden" name="tx_id" value={t.id} />
                    <select name="payment_id" className="inline" defaultValue="" aria-label="Payment this line belongs to">
                      <option value="">— which payment? —</option>
                      {sameAmount.length > 0 && (
                        <optgroup label={`Same amount (${kr(t.amount_sek)})`}>
                          {sameAmount.map((p) => <option key={p.id} value={p.id}>{p.member_name} · {describePayment(p)} · {p.code} · {paymentLabel(p.status)}</option>)}
                        </optgroup>
                      )}
                      {others.length > 0 && (
                        <optgroup label="Other open payments">
                          {others.map((p) => <option key={p.id} value={p.id}>{p.member_name} · {describePayment(p)} · {kr(p.amount_sek)} · {p.code}</option>)}
                        </optgroup>
                      )}
                    </select>
                    <button className="btn ink sm">Attach &amp; confirm</button>
                  </form>
                  <form action={ignoreTransaction}>
                    <input type="hidden" name="tx_id" value={t.id} />
                    <button className="btn quiet sm">Set aside</button>
                  </form>
                </div>
              </div>
            );
          })}
        </section>

        {/* 5. not paid yet */}
        <details className="card paysect" style={{ padding: 18 }}>
          <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Not paid yet <Count n={pendingOnly.length} /></h2><span className="muted small" style={{ marginLeft: 10 }}>booked, no &ldquo;I have paid&rdquo; yet</span></summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {pendingOnly.length === 0 && <div className="muted small">Everyone has paid or claimed.</div>}
            {pendingOnly.map((p) => (
              <div key={p.id} className="txrow">
                <div className="muted small">{p.booking_date ? bankDate(p.booking_date) : shortDate(new Date(p.created_at))}</div>
                <div style={{ minWidth: 0 }}><PayLine p={p} />{p.booking_status === "cancelled" ? <span className="muted small"> · booking cancelled</span> : null}</div>
                <div className="amt">{kr(p.amount_sek)}</div>
                <div className="actions">
                  <form action={confirmPayment}>
                    <input type="hidden" name="payment_id" value={p.id} />
                    <button className="btn line sm">Mark paid</button>
                  </form>
                </div>
              </div>
            ))}
          </div>
        </details>

        {/* 6. recently confirmed */}
        <details className="card paysect" style={{ padding: 18 }}>
          <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Confirmed recently</h2><span className="muted small" style={{ marginLeft: 10 }}>last {confirmed.length} · undo if something was wrong</span></summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {confirmed.length === 0 && <div className="muted small">Nothing confirmed yet.</div>}
            {confirmed.map((p) => (
              <div key={p.id} className="txrow">
                <div className="muted small">{p.confirmed_at ? shortDate(new Date(p.confirmed_at)) : "—"}</div>
                <div style={{ minWidth: 0 }}>
                  <PayLine p={p} />
                  <div className="muted small">{p.bank_date ? `bank ${bankDate(p.bank_date)} · ${p.bank_name ?? ""}` : Number(p.amount_sek) === 0 && Number(p.credit_sek ?? 0) > 0 ? "paid with credits" : "confirmed without a bank line"}</div>
                </div>
                <div className="amt">{kr(p.amount_sek)}</div>
                <div className="actions">
                  {!(Number(p.amount_sek) === 0 && Number(p.credit_sek ?? 0) > 0) && (
                    <form action={undoConfirmation}>
                      <input type="hidden" name="payment_id" value={p.id} />
                      <button className="btn quiet sm">Undo</button>
                    </form>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>

        {/* 7. kept aside */}
        <div className="muted small" style={{ padding: "0 4px" }}>
          {plural(nOut ?? 0, "line")} going out and {plural(nIgn ?? 0, "line")} set aside are kept for the ledger.{" "}
          <Link href={showOther ? "/payments" : "/payments?show=other"} style={{ color: "var(--red)", fontWeight: 600 }}>{showOther ? "Hide" : "Show"}</Link>
        </div>
        {showOther && (
          <section className="card stack paysect" style={{ padding: 18 }}>
            <h2>Kept aside</h2>
            {other.length === 0 && <div className="muted small">Nothing here.</div>}
            {other.map((t) => (
              <div key={t.id} className="txrow">
                <div className="muted small">{bankDate(t.booked_on)}</div>
                <div style={{ minWidth: 0 }}><b>{bankWho(t).who}</b><span className="muted small"> · {bankWho(t).detail ? `${bankWho(t).detail} · ` : ""}{t.status === "outgoing" ? "going out" : "set aside"}</span></div>
                <div className="amt" style={{ color: Number(t.amount_sek) < 0 ? "var(--muted)" : undefined }}>{kr(t.amount_sek)}</div>
                <div className="actions">
                  {t.status === "ignored" && (
                    <form action={restoreTransaction}>
                      <input type="hidden" name="tx_id" value={t.id} />
                      <button className="btn quiet sm">Back to waiting</button>
                    </form>
                  )}
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
