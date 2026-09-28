import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { roleLabels } from "@/lib/roles";
import { hm, longDate, parseISODate, sessionLabel, toISODate } from "@/lib/dates";
import { paymentClass } from "@/lib/payments";
import { cancelBooking } from "@/app/actions";
import { PaymentTag, Notice, TopNav } from "@/app/components";
import { credits, type CreditBalance } from "@/lib/credits";

export default async function MePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const todayISO = toISODate(new Date());
  const { data: bookings } = await supabase.from("bookings")
    .select("id, date, status, slot:slots(id, session, start_time, end_time), payment:payments(id, code, amount_sek, status)")
    .eq("member_id", me.id).eq("status", "booked").gte("date", todayISO).order("date");
  const [{ data: settings }, { data: creditRow }] = await Promise.all([
    supabase.from("settings").select("cancel_deadline_days").eq("id", 1).single(),
    supabase.from("credit_balances").select("balance, granted_this_year").eq("member_id", me.id).maybeSingle(),
  ]);
  const myCredits = creditRow as Pick<CreditBalance, "balance" | "granted_this_year"> | null;
  const list = bookings ?? [];

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>My seats</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
        <TopNav current="me" me={me} />
      </div>
      <div className="stack">
        <Notice error={error} ok={ok} />
        {myCredits && (
          <div className="card row between creditcard" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
            <div className="small"><b>Credits</b> <span className="creditnum">{credits(myCredits.balance)}</span><span className="muted"> · 1 credit = 1 kr — for the Store or a seat</span></div>
            <Link href="/me/credits" className="btn line sm">History</Link>
          </div>
        )}
        {list.length === 0 && (
          <div className="card dashed" style={{ padding: 24, textAlign: "center" }}>
            No upcoming seats. <Link href="/" style={{ color: "var(--red)", fontWeight: 600 }}>Pick one on the board</Link>.
          </div>
        )}
        {list.map((b) => {
          const slot = b.slot as unknown as { id: string; session: "day" | "evening"; start_time: string; end_time: string };
          const payment = b.payment as unknown as { id: string; code: string | null; amount_sek: number; status: string } | null;
          return (
            <div key={b.id} className={`card stack person ${paymentClass(payment?.status)}`} style={{ gap: 10, alignItems: "stretch", flexDirection: "column" }}>
              <div className="row between">
                <div>
                  <div className="bold">{longDate(parseISODate(b.date))}</div>
                  <div className="muted small">{sessionLabel(slot.session)} · {hm(slot.start_time)} – {hm(slot.end_time)}{payment?.code ? ` · ${payment.code}` : ""}</div>
                </div>
                <PaymentTag status={payment?.status} />
              </div>
              <div className="row" style={{ gap: 8 }}>
                {payment?.status === "pending" && <Link href={`/pay/${b.id}`} className="btn red sm">Pay {payment.amount_sek} kr</Link>}
                {payment?.status === "claimed" && <Link href={`/pay/${b.id}`} className="btn line sm">Details</Link>}
                <Link href={`/slot/${slot.id}/${b.date}`} className="btn line sm">Who&apos;s coming</Link>
                <form action={cancelBooking} className="grow" style={{ display: "flex", justifyContent: "flex-end" }}>
                  <input type="hidden" name="booking_id" value={b.id} />
                  <input type="hidden" name="back" value="/me" />
                  <button className="btn quiet sm">Cancel</button>
                </form>
              </div>
            </div>
          );
        })}
        <div className="muted small">Cancelling is free until {settings?.cancel_deadline_days ?? 1} day{(settings?.cancel_deadline_days ?? 1) === 1 ? "" : "s"} before the session.</div>
        <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
          <div className="small"><b>Receipts</b><span className="muted"> · paid for something for the association? Send the receipt and get it back.</span></div>
          <Link href="/me/receipts" className="btn line sm">Receipts</Link>
        </div>
      </div>
    </main>
  );
}
