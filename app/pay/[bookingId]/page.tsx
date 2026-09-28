import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hm, longDate, parseISODate, sessionLabel } from "@/lib/dates";
import { formatSwishNumber, swishUrl } from "@/lib/swish";
import { applyCredits, claimPayment, releaseCredits } from "@/app/actions";
import { Chevron, Notice } from "@/app/components";
import { balanceOf, credits, creditsHeld } from "@/lib/credits";

export default async function PayPage({ params, searchParams }: { params: Promise<{ bookingId: string }>; searchParams: Promise<{ error?: string; ok?: string; c?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { bookingId } = await params;
  const { error, ok, c } = await searchParams;
  const supabase = await createClient();
  const { data: b } = await supabase.from("bookings")
    .select("id, date, member_id, status, slot:slots(id, session, start_time, end_time, weekday, capacity, instructor:members!slots_instructor_id_fkey(name)), payment:payments(id, code, amount_sek, status, note, credit_sek, credit_returned_sek)")
    .eq("id", bookingId).single();
  if (!b || b.member_id !== me.id) notFound();
  const [{ data: settings }, balance] = await Promise.all([
    supabase.from("settings").select("swish_number, swish_payee_name").eq("id", 1).single(),
    balanceOf(supabase, me.id),
  ]);

  const slot = b.slot as unknown as { id: string; session: "day" | "evening"; start_time: string; end_time: string; capacity: number; instructor: { name: string } | null };
  const payment = b.payment as unknown as { id: string; code: string | null; amount_sek: number; status: string; note: string | null; credit_sek: number | null; credit_returned_sek: number | null };
  const d = parseISODate(b.date);
  const payee = settings?.swish_number ?? "";
  const message = payment.note ?? `${payment.code ?? ""} ${b.date} ${me.name}`.trim();
  const link = swishUrl({ payee, amountSek: payment.amount_sek, message });
  const confirmed = payment.status === "confirmed";
  const claimed = payment.status === "claimed";
  const cancelled = payment.status === "cancelled" || b.status === "cancelled";
  const creditUsed = Number(payment.credit_sek ?? 0);
  const creditBack = Number(payment.credit_returned_sek ?? 0);
  const pending = payment.status === "pending";
  const here = `/pay/${b.id}`;
  const onlyCredits = confirmed && creditUsed > 0 && payment.amount_sek === 0;
  const okText = ok === "credits_used" && c ? (confirmed ? `Paid with ${credits(c)}. See you there.` : `${credits(c)} used — pay the rest with Swish.`) : undefined;

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href={`/slot/${slot.id}/${b.date}`} className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Back to the seat</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{cancelled ? "Cancelled" : onlyCredits ? "Paid with credits" : confirmed ? "Paid" : claimed ? "Awaiting confirmation" : "Seat booked"}</h1>
          <div className="muted">{cancelled ? `This booking was cancelled.${creditBack > 0 ? ` ${credits(creditBack)} went back to your balance.` : ""}` : confirmed ? "This seat is paid. See you there." : claimed ? "The treasurer confirms your Swish payment when it shows up in the bank." : `Your seat is held — ${balance > 0 ? "pay with credits or Swish" : "pay with Swish"} to finish.`}</div>
        </div>
        <Notice error={error} ok={ok} text={okText} />

        <div className="card stack" style={{ gap: 14, padding: 18 }}>
          <div className="kv"><span className="k">Date</span><span className="v">{longDate(d)}</span></div>
          <div className="kv"><span className="k">Session</span><span className="v">{sessionLabel(slot.session)} · {hm(slot.start_time)} – {hm(slot.end_time)}</span></div>
          <div className="kv"><span className="k">Teacher</span><span className="v">{slot.instructor?.name ? `Teacher ${slot.instructor.name}` : "Not set yet"}</span></div>
          <div className="divider" />
          <div className="kv"><span className="k">Amount</span><span className="amount">{payment.amount_sek + creditUsed} kr</span></div>
          {creditUsed > 0 && (
            <>
              <div className="kv"><span className="k">Paid with credits</span><span className="v">{credits(creditUsed)}</span></div>
              {payment.amount_sek > 0 && <div className="kv"><span className="k">{confirmed ? "Paid with Swish" : "Left to pay with Swish"}</span><span className="v">{payment.amount_sek} kr</span></div>}
            </>
          )}
          {payment.code && <div className="kv"><span className="k">Payment code</span><span className="v"><span className="tag code">{payment.code}</span></span></div>}
        </div>

        {!confirmed && !cancelled && (
          <div className="card stack" style={{ gap: 10, padding: "16px 18px" }}>
            <div className="muted small bold">Pre-filled in Swish</div>
            <div className="kv"><span className="k">To</span><span className="v">{settings?.swish_payee_name} · {formatSwishNumber(payee)}</span></div>
            <div className="kv"><span className="k">Message</span><span className="v">{message}</span></div>
            <div className="muted small">On a computer? Open Swish on your phone and send {payment.amount_sek} kr to {formatSwishNumber(payee)} with the message above — keep the code, it is how your payment is recognised.</div>
          </div>
        )}
      </div>

      <div className="footer">
        {!confirmed && !cancelled && (
          <>
            {pending && balance >= payment.amount_sek && (
              <form action={applyCredits}>
                <input type="hidden" name="payment_id" value={payment.id} />
                <input type="hidden" name="back" value={here} />
                <button className="btn red">Pay with {credits(payment.amount_sek)}</button>
              </form>
            )}
            <a href={link} className={`btn ${pending && balance >= payment.amount_sek ? "line" : "ink"}`}>Open Swish and pay {payment.amount_sek} kr</a>
            {pending && balance > 0 && balance < payment.amount_sek && (
              <form action={applyCredits}>
                <input type="hidden" name="payment_id" value={payment.id} />
                <input type="hidden" name="back" value={here} />
                <button className="btn line">Use my {credits(balance)}, Swish the rest</button>
              </form>
            )}
            {pending && creditsHeld(payment) > 0 && (
              <form action={releaseCredits}>
                <input type="hidden" name="payment_id" value={payment.id} />
                <input type="hidden" name="back" value={here} />
                <button className="btn quiet">Keep my credits — pay all with Swish</button>
              </form>
            )}
            {!claimed && (
              <form action={claimPayment}>
                <input type="hidden" name="payment_id" value={payment.id} />
                <button className="btn line">I have paid</button>
              </form>
            )}
            <Link href="/me" className="btn quiet">Hold the seat, pay later</Link>
            <div className="muted small" style={{ textAlign: "center" }}>After paying, tap &ldquo;I have paid&rdquo; — you show as awaiting confirmation until the treasurer sees it in the bank.</div>
          </>
        )}
        {(confirmed || cancelled) && <Link href="/" className="btn ink">Back to the board</Link>}
      </div>
    </main>
  );
}
