import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hm, longDate, parseISODate, sessionLabel } from "@/lib/dates";
import { formatSwishNumber, swishUrl } from "@/lib/swish";
import { markPending } from "@/app/actions";
import { Chevron } from "@/app/components";

export default async function PayPage({ params }: { params: Promise<{ bookingId: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { bookingId } = await params;
  const supabase = await createClient();
  const { data: b } = await supabase.from("bookings")
    .select("id, date, member_id, status, slot:slots(id, session, start_time, end_time, weekday, capacity, instructor:members!slots_instructor_id_fkey(name)), charge:charges(id, amount_sek, status, note)")
    .eq("id", bookingId).single();
  if (!b || b.member_id !== me.id) notFound();
  const { data: settings } = await supabase.from("settings").select("swish_number, swish_payee_name").eq("id", 1).single();

  const slot = b.slot as unknown as { id: string; session: "day" | "evening"; start_time: string; end_time: string; capacity: number; instructor: { name: string } | null };
  const charge = b.charge as unknown as { id: string; amount_sek: number; status: string; note: string | null };
  const d = parseISODate(b.date);
  const payee = settings?.swish_number ?? "";
  const message = charge.note ?? `${b.date} ${me.name}`;
  const link = swishUrl({ payee, amountSek: charge.amount_sek, message });
  const alreadyPaid = charge.status === "paid";
  const pending = charge.status === "pending";

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href={`/slot/${slot.id}/${b.date}`} className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Back to the seat</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{alreadyPaid ? "Paid" : pending ? "Awaiting confirmation" : "Seat booked"}</h1>
          <div className="muted">{alreadyPaid ? "This seat is paid. See you there." : pending ? "An admin will confirm your Swish payment." : "Your seat is held — pay with Swish to finish."}</div>
        </div>

        <div className="card stack" style={{ gap: 14, padding: 18 }}>
          <div className="kv"><span className="k">Date</span><span className="v">{longDate(d)}</span></div>
          <div className="kv"><span className="k">Session</span><span className="v">{sessionLabel(slot.session)} · {hm(slot.start_time)} – {hm(slot.end_time)}</span></div>
          <div className="kv"><span className="k">Teacher</span><span className="v">{slot.instructor?.name ? `Teacher ${slot.instructor.name}` : "Not set yet"}</span></div>
          <div className="divider" />
          <div className="kv"><span className="k">Amount</span><span className="amount">{charge.amount_sek} kr</span></div>
        </div>

        {!alreadyPaid && (
          <div className="card stack" style={{ gap: 10, padding: "16px 18px" }}>
            <div className="muted small bold">Pre-filled in Swish</div>
            <div className="kv"><span className="k">To</span><span className="v">{settings?.swish_payee_name} · {formatSwishNumber(payee)}</span></div>
            <div className="kv"><span className="k">Message</span><span className="v">{message}</span></div>
            <div className="muted small">On a computer? Open Swish on your phone and send {charge.amount_sek} kr to {formatSwishNumber(payee)} with the message above.</div>
          </div>
        )}
      </div>

      <div className="footer">
        {!alreadyPaid && (
          <>
            <a href={link} className="btn ink">Open Swish and pay</a>
            {!pending && (
              <form action={markPending}>
                <input type="hidden" name="charge_id" value={charge.id} />
                <button className="btn line">I have paid</button>
              </form>
            )}
            <Link href="/me" className="btn quiet">Hold the seat, pay later</Link>
            <div className="muted small" style={{ textAlign: "center" }}>After paying, tap &ldquo;I have paid&rdquo; — you show as awaiting confirmation until an admin marks you as paid.</div>
          </>
        )}
        {alreadyPaid && <Link href="/" className="btn ink">Back to the board</Link>}
      </div>
    </main>
  );
}
