import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { formatSwishNumber, swishUrl } from "@/lib/swish";
import { cancelPass } from "@/app/actions";
import { Chevron, Notice } from "@/app/components";
import { passWorks, periodLabel, periodName, type PassRow } from "@/lib/passes";
import { SwishPay } from "@/app/pay/[bookingId]/SwishPay";

/** A monthly pass: pay it with Swish (credits are not for passes), see it, cancel it before paying. */
export default async function PassPayPage({ params, searchParams }: { params: Promise<{ passId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { passId } = await params;
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: row }, { data: settings }] = await Promise.all([
    supabase.from("passes_view").select("*").eq("id", passId).maybeSingle(),
    supabase.from("settings").select("swish_number, swish_payee_name").eq("id", 1).single(),
  ]);
  const p = row as PassRow | null;
  if (!p || p.member_id !== me.id) notFound();
  const { data: pay } = p.payment_id
    ? await supabase.from("payments").select("note, amount_sek").eq("id", p.payment_id).single()
    : { data: null };

  const payee = settings?.swish_number ?? "";
  const amount = Number(pay?.amount_sek ?? p.price_sek);
  const message = pay?.note ?? `${p.code ?? ""} Pass ${me.name}`.trim();
  const link = swishUrl({ payee, amountSek: amount, message });
  const cancelled = p.status === "cancelled";
  const pending = !cancelled && p.payment_status === "pending";
  const claimed = !cancelled && p.payment_status === "claimed";
  const works = passWorks(p);
  const back = "/me?pass=1";

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href="/me" className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Back to My seats</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{cancelled ? "Pass cancelled" : works ? "Your pass" : "Pay your pass"}</h1>
          <div className="muted">
            {cancelled ? "This pass no longer covers seats."
              : p.payment_status === "confirmed" ? "Paid. Book seats without paying."
              : claimed ? "The pass works already — the treasurer confirms the payment when it shows up in the bank."
              : "Pay with Swish, then tap “I have paid” — the pass works from that moment."}
          </div>
        </div>
        <Notice error={error} ok={ok} />

        <div className={`card stack ${works ? "person paid" : ""}`} style={{ gap: 14, padding: 18, alignItems: "stretch", flexDirection: "column" }}>
          <div className="kv"><span className="k">Pass</span><span className="v">{p.label}</span></div>
          <div className="kv"><span className="k">Period</span><span className="v">{periodLabel(p.period_start, p.period_end)}</span></div>
          <div className="kv"><span className="k">Seats booked on it</span><span className="v">{p.seats}</span></div>
          <div className="divider" />
          <div className="kv"><span className="k">Amount</span><span className="amount">{amount} kr</span></div>
          {p.code && <div className="kv"><span className="k">Payment code</span><span className="v"><span className="tag code">{p.code}</span></span></div>}
        </div>

        {(pending || claimed) && (
          <div className="card stack" style={{ gap: 10, padding: "16px 18px" }}>
            <div className="muted small bold">Pre-filled in Swish</div>
            <div className="kv"><span className="k">To</span><span className="v">{settings?.swish_payee_name} · {formatSwishNumber(payee)}</span></div>
            <div className="kv"><span className="k">Message</span><span className="v">{message}</span></div>
            <div className="muted small">On a computer? Open Swish on your phone and send {amount} kr to {formatSwishNumber(payee)} with the message above. Credits can&apos;t be used for a pass.</div>
          </div>
        )}
      </div>

      <div className="footer">
        {(pending || claimed) && p.payment_id && (
          <SwishPay link={link} amount={amount} paymentId={p.payment_id} back={back} backLabel="My seats" claimed={claimed} primary />
        )}
        {pending && (
          <>
            <Link href={`/pass?period=${p.period_start}`} className="btn quiet">Choose another pass</Link>
            <form action={cancelPass}>
              <input type="hidden" name="pass_id" value={p.id} />
              <input type="hidden" name="back" value="/me" />
              <button className="btn quiet">Cancel this pass</button>
            </form>
          </>
        )}
        {(works || cancelled) && <Link href="/me" className="btn ink">Back to My seats</Link>}
        {works && <div className="muted small" style={{ textAlign: "center" }}>Valid for {periodName(p.period_start, p.period_end)}.</div>}
      </div>
    </main>
  );
}
