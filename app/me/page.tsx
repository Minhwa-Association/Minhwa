import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { roleLabels } from "@/lib/roles";
import { hm, longDate, parseISODate, sessionLabel, toISODate } from "@/lib/dates";
import { paymentClass } from "@/lib/payments";
import { todayStockholm, addDays, mondayOf } from "@/lib/dates";
import { cancelledText, waitPosition, type WaitRow } from "@/lib/waitlist";
import { cancelBooking, claimPayment, leaveWaitlist } from "@/app/actions";
import { LoadError, PassTag, PaymentTag, Notice, TopNav, WaitTag } from "@/app/components";
import { loadFailed } from "@/lib/loadError";
import { daysBetween, PASS_REMIND_DAYS, passWorks, periodName, shortDay, type PassOffer, type PassRow } from "@/lib/passes";
import { paymentLabel } from "@/lib/payments";
import { credits, type CreditBalance } from "@/lib/credits";

export default async function MePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string; to?: string; pass?: string; cr?: string; later?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok, to, pass: fromPass, cr, later } = await searchParams;
  const supabase = await createClient();
  const todayISO = todayStockholm();
  const [{ data: bookings, error: bookingsErr }, { data: waitingRows, error: waitErr }, { data: settings }, { data: creditRow }, { data: passRows, error: passErr }, { data: offerRows, error: offerErr }] = await Promise.all([
    supabase.from("bookings")
      .select("id, date, status, promoted_at, pass_id, slot:slots(id, session, start_time, end_time), payment:payments(id, code, amount_sek, status)")
      .eq("member_id", me.id).eq("status", "booked").gte("date", todayISO).order("date"),
    // every live waiting-list row from today on — to know my place in each list
    supabase.from("waitlist").select("id, member_id, slot_id, date, created_at, slot:slots(id, session, start_time, end_time)")
      .eq("status", "waiting").gte("date", todayISO).order("date").order("created_at"),
    supabase.from("settings").select("cancel_deadline_days, pass_twice_per_week, pass_max_upcoming").eq("id", 1).single(),
    supabase.from("credit_balances").select("balance, granted_this_year").eq("member_id", me.id).maybeSingle(),
    supabase.from("passes_view").select("*").eq("member_id", me.id).eq("status", "active").gte("period_end", todayISO).order("period_start"),
    supabase.rpc("pass_offer"),
  ]);
  const myPasses = (passRows ?? []) as PassRow[];
  const offers = (offerRows ?? []) as PassOffer[];
  const curPass = myPasses.find((p) => p.period_start <= todayISO && p.period_end >= todayISO) ?? null;
  const nextPass = myPasses.find((p) => p.period_start > todayISO) ?? null;
  const nextOffer = offers.find((o) => o.period_start > todayISO) ?? null;
  const openOffer = offers.find((o) => o.open && !myPasses.some((p) => p.period_start === o.period_start)) ?? null;
  // this week's seats on the pass (twice a week) — bookings from Monday, including days that have passed
  // on Saturday and Sunday the week to look at is the coming one (sessions are Mon–Fri)
  const todayDate = parseISODate(todayISO);
  const weekend = todayDate.getDay() === 0 || todayDate.getDay() === 6;
  const weekMonday = weekend ? addDays(mondayOf(todayDate), 7) : mondayOf(todayDate);
  const weekStart = toISODate(weekMonday);
  const weekEnd = toISODate(addDays(weekMonday, 6));
  const { data: weekRows, error: weekErr } = curPass
    ? await supabase.from("bookings").select("id").eq("pass_id", curPass.id).eq("status", "booked").gte("date", weekStart).lte("date", weekEnd)
    : { data: [], error: null };
  // a failed read must not look like "no upcoming seats"
  if (loadFailed("me", { bookings: bookingsErr, waitlist: waitErr, passes: passErr, pass_offer: offerErr, pass_week: weekErr })) {
    return (
      <main className="page">
        <div className="topbar">
          <div><h1>My seats</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
          <TopNav current="me" me={me} />
        </div>
        <LoadError what="your seats" retry="/me" />
      </main>
    );
  }
  // v19.2: seats and waiting-list places a holiday cancelled, from today on (read errors ignored: before the
  // v19.2 SQL is run the column isn't there, and nothing would show anyway)
  const [{ data: holidaySeatRows }, { data: holidayWaitRows }] = await Promise.all([
    supabase.from("bookings")
      .select("id, date, pass_id, closure:closures(reason), slot:slots(session), payment:payments(status, credited_sek, credit_returned_sek)")
      .eq("member_id", me.id).eq("status", "cancelled").not("closure_id", "is", null).gte("date", todayISO).order("date"),
    supabase.from("waitlist")
      .select("id, date, closure:closures(reason), slot:slots(session)")
      .eq("member_id", me.id).eq("status", "left").not("closure_id", "is", null).gte("date", todayISO).order("date"),
  ]);
  type HolidayRow = { id: string; date: string; pass_id?: string | null; closure: { reason: string } | null; slot: { session: "day" | "evening" } | null; payment?: { status: string; credited_sek: number | null; credit_returned_sek: number | null } | null; waiting?: boolean };
  const holidayRows: HolidayRow[] = [
    ...((holidaySeatRows ?? []) as unknown as HolidayRow[]),
    ...((holidayWaitRows ?? []) as unknown as HolidayRow[]).map((w) => ({ ...w, waiting: true })),
  ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const holidayBack = (h: HolidayRow): string => {
    if (h.waiting) return "You were on the waiting list — taken off.";
    if (!h.payment) return h.pass_id ? "It was on your monthly pass — it no longer counts." : "";
    const now = Number(h.payment.credited_sek ?? 0) + Number(h.payment.credit_returned_sek ?? 0);
    if (h.payment.status === "claimed") return `${now > 0 ? `${credits(now)} back now; your` : "Your"} Swish payment comes back as credits when the treasurer sees it in the bank.`;
    return now > 0 ? `${credits(now)} back to your balance.` : "Nothing was paid.";
  };
  const weekUsed = (weekRows ?? []).length;
  const perWeek = settings?.pass_twice_per_week ?? 2;
  const maxUpcoming = settings?.pass_max_upcoming ?? 4;
  const daysLeft = curPass ? daysBetween(todayISO, curPass.period_end) : 99;
  const remind = !!curPass && passWorks(curPass) && daysLeft <= PASS_REMIND_DAYS && !nextPass && !!nextOffer;
  const myCredits = creditRow as Pick<CreditBalance, "balance" | "granted_this_year"> | null;
  const list = bookings ?? [];
  const allWaiting = (waitingRows ?? []) as unknown as (WaitRow & { slot: { id: string; session: "day" | "evening"; start_time: string; end_time: string } })[];
  const myWaiting = allWaiting.filter((w) => w.member_id === me.id);
  type Item = { kind: "seat"; date: string; b: (typeof list)[number] } | { kind: "wait"; date: string; w: (typeof myWaiting)[number] };
  const items: Item[] = [...list.map((b) => ({ kind: "seat" as const, date: b.date, b })), ...myWaiting.map((w) => ({ kind: "wait" as const, date: w.date, w }))]
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const deadline = settings?.cancel_deadline_days ?? 1;
  const noticeText = ok === "cancelled" ? cancelledText(to, cr, later)
    : ok === "paid" && fromPass ? "Thanks — your pass works now: book seats without paying. The treasurer confirms the payment when it shows up in the bank."
    : undefined;

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>My seats</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
        <TopNav current="me" me={me} />
      </div>
      <div className="stack">
        <Notice error={error} ok={ok} text={noticeText} />
        {holidayRows.length > 0 && (
          <div className="card stack" style={{ gap: 8, padding: "12px 16px", border: "1.5px dashed var(--dash)" }}>
            <div className="bold">Cancelled for a holiday</div>
            {holidayRows.map((h) => (
              <div key={h.id} className="small">
                <b>{longDate(parseISODate(h.date))}{h.slot ? ` · ${sessionLabel(h.slot.session)}` : ""}</b>
                <span className="muted"> — {h.closure?.reason ?? "Holiday"}.</span> {holidayBack(h)}
              </div>
            ))}
          </div>
        )}
        {curPass ? (
          <div className={`card stack person ${passWorks(curPass) ? "paid" : ""}`} style={{ gap: 8, alignItems: "stretch", flexDirection: "column", padding: "12px 16px" }}>
            <div className="row between">
              <div><b>{curPass.label}</b><span className="muted small"> · {periodName(curPass.period_start, curPass.period_end)}</span></div>
              {passWorks(curPass) ? <PassTag /> : <span className="tag unpaid">{paymentLabel(curPass.payment_status)}</span>}
            </div>
            {passWorks(curPass) && (
              <div className="small">
                {curPass.kind === "twice"
                  ? <>{weekend ? "Next week" : "This week"}: <b>{Math.min(weekUsed, perWeek)} of {perWeek}</b> used{weekUsed >= perWeek ? " — another session this week is the usual price" : ""}.</>
                  : <>Upcoming seats on the pass: <b>{curPass.seats_upcoming} of {maxUpcoming}</b>.</>}
                <span className="muted"> Ends {shortDay(curPass.period_end)}.</span>
              </div>
            )}
            {!passWorks(curPass) && <div className="small muted">Pay it to start using it — seats you book until then are the usual price, and move onto the pass once you tap &ldquo;I have paid&rdquo;.</div>}
            {remind && <div className="small" style={{ color: "var(--gold-text)", fontWeight: 600 }}>Your pass ends {daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`} — get {periodName(nextOffer!.period_start, nextOffer!.period_end)}&apos;s{nextOffer!.open ? "" : ` from ${shortDay(nextOffer!.buy_from)}`}.</div>}
            {nextPass && <div className="small muted">Next: {nextPass.label} · {periodName(nextPass.period_start, nextPass.period_end)} · {passWorks(nextPass) ? "ready" : paymentLabel(nextPass.payment_status).toLowerCase()}</div>}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <Link href={`/pass/${curPass.id}`} className={`btn ${passWorks(curPass) ? "line" : "red"} sm`}>{passWorks(curPass) ? "Details" : `Pay ${curPass.price_sek} kr`}</Link>
              {nextPass && !passWorks(nextPass) && <Link href={`/pass/${nextPass.id}`} className="btn red sm">Pay next pass</Link>}
              {openOffer && <Link href={`/pass?period=${openOffer.period_start}`} className={`btn ${remind ? "red" : "line"} sm`}>Get {periodName(openOffer.period_start, openOffer.period_end)}&apos;s pass</Link>}
            </div>
          </div>
        ) : (nextPass || nextOffer) ? (
          <div className={`card stack ${nextPass && passWorks(nextPass) ? "person paid" : ""}`} style={{ gap: 8, alignItems: "stretch", flexDirection: "column", padding: "12px 16px" }}>
            {nextPass ? (
              <>
                <div className="row between">
                  <div><b>{nextPass.label}</b><span className="muted small"> · {periodName(nextPass.period_start, nextPass.period_end)}</span></div>
                  {passWorks(nextPass) ? <PassTag /> : <span className="tag unpaid">{paymentLabel(nextPass.payment_status)}</span>}
                </div>
                <div className="small muted">Starts {shortDay(nextPass.period_start)}. Seats from then on are covered{passWorks(nextPass) ? "" : " once it is paid"}.</div>
                <div className="row"><Link href={`/pass/${nextPass.id}`} className={`btn ${passWorks(nextPass) ? "line" : "red"} sm`}>{passWorks(nextPass) ? "Details" : `Pay ${nextPass.price_sek} kr`}</Link></div>
              </>
            ) : (
              <>
                <div className="small"><b>Monthly pass</b><span className="muted"> · pay once, book without paying. From {shortDay(nextOffer!.period_start)}.</span></div>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  {nextOffer!.open
                    ? <Link href={`/pass?period=${nextOffer!.period_start}`} className="btn red sm">Get a pass</Link>
                    : <><Link href={`/pass?period=${nextOffer!.period_start}`} className="btn line sm">See the passes</Link><span className="muted small">On sale from {shortDay(nextOffer!.buy_from)}</span></>}
                </div>
              </>
            )}
          </div>
        ) : null}
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
          const onPass = !!b.pass_id && !payment;
          return (
            <div key={b.id} className={`card stack person ${onPass ? "paid" : paymentClass(payment?.status)}`} style={{ gap: 10, alignItems: "stretch", flexDirection: "column" }}>
              <div className="row between">
                <div>
                  <div className="bold">{longDate(parseISODate(b.date))}</div>
                  <div className="muted small">{sessionLabel(slot.session)} · {hm(slot.start_time)} – {hm(slot.end_time)}{payment?.code ? ` · ${payment.code}` : ""}</div>
                </div>
                {onPass ? <PassTag /> : <PaymentTag status={payment?.status} />}
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
                  <button className="btn quiet sm">{fromWaitlistUnpaid || (onPass && b.promoted_at) ? "Decline" : "Cancel"}</button>
                </form>
              </div>
            </div>
          );
        
        })}
        <div className="muted small">Cancelling is free until {deadline} day{deadline === 1 ? "" : "s"} before the session — what you paid comes back as credits (1 credit = 1 kr). A seat that came to you from the waiting list can be declined any time before you pay.</div>
        <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
          <div className="small"><b>My payments</b><span className="muted"> · what you paid, with a receipt (kvitto) for each — open or save as PDF.</span></div>
          <Link href="/me/payments" className="btn line sm">Payments</Link>
        </div>
        <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 8 }}>
          <div className="small"><b>Receipts</b><span className="muted"> · paid for something for the association? Send the receipt and get it back.</span></div>
          <Link href="/me/receipts" className="btn line sm">Receipts</Link>
        </div>
      </div>
    </main>
  );
}
