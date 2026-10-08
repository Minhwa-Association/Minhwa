import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { roleLabels } from "@/lib/roles";
import { hm, longDate, parseISODate, sessionLabel, toISODate } from "@/lib/dates";
import { paymentClass } from "@/lib/payments";
import { cancelledText, waitPosition, type WaitRow } from "@/lib/waitlist";
import { cancelBooking, claimPayment, leaveWaitlist } from "@/app/actions";
import { PaymentTag, Notice, TopNav, WaitTag } from "@/app/components";
import { credits, type CreditBalance } from "@/lib/credits";

export default async function MePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string; to?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok, to } = await searchParams;
  const supabase = await createClient();
  const todayISO = toISODate(new Date());
  const [{ data: bookings }, { data: waitingRows }, { data: settings }, { data: creditRow }] = await Promise.all([
    supabase.from("bookings")
      .select("id, date, status, promoted_at, slot:slots(id, session, start_time, end_time), payment:payments(id, code, amount_sek, status)")
      .eq("member_id", me.id).eq("status", "booked").gte("date", todayISO).order("date"),
    // every live waiting-list row from today on — to know my place in each list
    supabase.from("waitlist").select("id, member_id, slot_id, date, created_at, slot:slots(id, session, start_time, end_time)")
      .eq("status", "waiting").gte("date", todayISO).order("date").order("created_at"),
    supabase.from("settings").select("cancel_deadline_days").eq("id", 1).single(),
    supabase.from("credit_balances").select("balance, granted_this_year").eq("member_id", me.id).maybeSingle(),
  ]);
  const myCredits = creditRow as Pick<CreditBalance, "balance" | "granted_this_year"> | null;
  const list = bookings ?? [];
  const allWaiting = (waitingRows ?? []) as unknown as (WaitRow & { slot: { id: string; session: "day" | "evening"; start_time: string; end_time: string } })[];
  const myWaiting = allWaiting.filter((w) => w.member_id === me.id);
  type Item = { kind: "seat"; date: string; b: (typeof list)[number] } | { kind: "wait"; date: string; w: (typeof myWaiting)[number] };
  const items: Item[] = [...list.map((b) => ({ kind: "seat" as const, date: b.date, b })), ...myWaiting.map((w) => ({ kind: "wait" as const, date: w.date, w }))]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const deadline = settings?.cancel_deadline_days ?? 1;
  const noticeText = ok === "cancelled" && to ? cancelledText(to) : undefined;

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>My seats</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
        <TopNav current="me" me={me} />
      </div>
      <div className="stack">
        <Notice error={error} ok={ok} text={noticeText} />
        {myCredits && (
          <div className="card row between creditcard" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
            <div className="small"><b>Credits</b> <span className="creditnum">{credits(myCredits.balance)}</span><span className="muted"> · 1 credit = 1 kr — for the Store or a seat</span></div>
            <Link href="/me/credits" className="btn line sm">History</Link>
          </div>
        )}
        {list.length === 0 && myWaiting.length === 0 && (
          <div className="card dashed" style={{ padding: 24, textAlign: "center" }}>
            No upcoming seats. <Link href="/" style={{ color: "var(--red)", fontWeight: 600 }}>Pick one on the board</Link>.
          </div>
        )}
        {items.map((it) => {
          if (it.kind === "wait") {
            const w = it.w;
            const position = waitPosition(allWaiting, me.id, w.slot_id, w.date);
            return (
              <div key={w.id} className="card stack person wait" style={{ gap: 10, alignItems: "stretch", flexDirection: "column" }}>
                <div className="row between">
                  <div>
                    <div className="bold">{longDate(parseISODate(w.date))}</div>
                    <div className="muted small">{sessionLabel(w.slot.session)} · {hm(w.slot.start_time)} – {hm(w.slot.end_time)}</div>
                  </div>
                  <WaitTag position={position} />
                </div>
                <div className="small muted">When a seat frees up it is yours automatically — it shows up here to pay.</div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <Link href={`/slot/${w.slot_id}/${w.date}`} className="btn line sm">Who&apos;s coming</Link>
                  <form action={leaveWaitlist} className="grow" style={{ display: "flex", justifyContent: "flex-end" }}>
                    <input type="hidden" name="waitlist_id" value={w.id} />
                    <input type="hidden" name="back" value="/me" />
                    <button className="btn quiet sm">Leave the list</button>
                  </form>
                </div>
              </div>
            );
          }
          const b = it.b;
          const slot = b.slot as unknown as { id: string; session: "day" | "evening"; start_time: string; end_time: string };
          const payment = b.payment as unknown as { id: string; code: string | null; amount_sek: number; status: string } | null;
          const fromWaitlistUnpaid = !!b.promoted_at && payment?.status === "pending";
          return (
            <div key={b.id} className={`card stack person ${paymentClass(payment?.status)}`} style={{ gap: 10, alignItems: "stretch", flexDirection: "column" }}>
              <div className="row between">
                <div>
                  <div className="bold">{longDate(parseISODate(b.date))}</div>
                  <div className="muted small">{sessionLabel(slot.session)} · {hm(slot.start_time)} – {hm(slot.end_time)}{payment?.code ? ` · ${payment.code}` : ""}</div>
                </div>
                <PaymentTag status={payment?.status} />
              </div>
              {fromWaitlistUnpaid && <div className="small" style={{ color: "var(--gold-text)" }}>You got this seat from the waiting list — pay to keep it, or decline it (free until you pay).</div>}
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {payment?.status === "pending" && <Link href={`/pay/${b.id}?from=me`} className="btn red sm">Pay {payment.amount_sek} kr</Link>}
                {payment?.status === "pending" && (
                  <form action={claimPayment}>
                    <input type="hidden" name="payment_id" value={payment.id} />
                    <input type="hidden" name="back" value="/me" />
                    <button className="btn line sm">I have paid</button>
                  </form>
                )}
                {payment?.status === "claimed" && <Link href={`/pay/${b.id}?from=me`} className="btn line sm">Details</Link>}
                <Link href={`/slot/${slot.id}/${b.date}`} className="btn line sm">Who&apos;s coming</Link>
                <form action={cancelBooking} className="grow" style={{ display: "flex", justifyContent: "flex-end" }}>
                  <input type="hidden" name="booking_id" value={b.id} />
                  <input type="hidden" name="back" value="/me" />
                  <button className="btn quiet sm">{fromWaitlistUnpaid ? "Decline" : "Cancel"}</button>
                </form>
              </div>
            </div>
          );
        
        })}
        <div className="muted small">Cancelling is free until {deadline} day{deadline === 1 ? "" : "s"} before the session. A seat that came to you from the waiting list can be declined any time before you pay.</div>
        <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
          <div className="small"><b>Receipts</b><span className="muted"> · paid for something for the association? Send the receipt and get it back.</span></div>
          <Link href="/me/receipts" className="btn line sm">Receipts</Link>
        </div>
      </div>
    </main>
  );
}
