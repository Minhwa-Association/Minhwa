import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hm, isValidISODate, longDate, parseISODate, sessionLabel, WEEKDAYS_LONG } from "@/lib/dates";
import { paymentClass } from "@/lib/payments";
import { byCreated, cancelledText } from "@/lib/waitlist";
import { bookSeat, cancelBooking, claimPayment, joinWaitlist, leaveWaitlist } from "@/app/actions";
import { PassTag, PaymentTag, Chevron, Notice, LoadError } from "@/app/components";
import { loadFailed } from "@/lib/loadError";
import type { PassCover } from "@/lib/passes";
import { SubmitButton } from "@/app/SubmitButton";

export default async function SlotPage({ params, searchParams }: {
  params: Promise<{ slotId: string; date: string }>;
  searchParams: Promise<{ error?: string; ok?: string; to?: string; cr?: string; later?: string }>;
}) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { slotId, date } = await params;
  const { error, ok, to, cr, later } = await searchParams;
  if (!isValidISODate(date)) notFound();

  const supabase = await createClient();
  const [{ data: slot, error: slotErr }, { data: bookings, error: bookingsErr }, { data: waiting, error: waitErr }, { data: settings }, { data: coverRow, error: coverErr }] = await Promise.all([
    supabase.from("slots").select("id, weekday, session, start_time, end_time, capacity, instructor_id, whatsapp_url, instructor:members!slots_instructor_id_fkey(name)").eq("id", slotId).single(),
    supabase.from("bookings").select("id, member_id, created_at, payment_id, pass_id, promoted_at, member:members(name)").eq("slot_id", slotId).eq("date", date).eq("status", "booked").order("created_at"),
    supabase.from("waitlist").select("id, member_id, created_at, member:members(name)").eq("slot_id", slotId).eq("date", date).eq("status", "waiting").order("created_at"),
    supabase.from("settings").select("seat_price_sek, cancel_deadline_days, pass_twice_per_week, pass_max_upcoming").eq("id", 1).single(),
    supabase.rpc("my_pass_cover", { p_date: date }),
  ]);
  // a failed read must not look like "nobody booked" (PGRST116 = no such slot → 404 below)
  if (loadFailed("slot", { slot: slotErr?.code === "PGRST116" ? null : slotErr, bookings: bookingsErr, waitlist: waitErr, pass_cover: coverErr })) {
    return (
      <main className="page">
        <div style={{ paddingTop: 20 }} className="stack">
          <Link href="/" className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Weekly board</Link>
          <div>
            <h1 style={{ fontSize: 32 }}>{slot ? `${WEEKDAYS_LONG[slot.weekday - 1]} · ${sessionLabel(slot.session)}` : "Session"}</h1>
            <div className="muted">{longDate(parseISODate(date))}</div>
          </div>
          <LoadError what="the seats" retry={`/slot/${slotId}/${date}`} />
        </div>
      </main>
    );
  }
  const cover = ((coverRow as string | null) ?? "none") as PassCover;
  if (!slot) notFound();

  const list = bookings ?? [];
  const queue = [...(waiting ?? [])].sort(byCreated);
  const mine = list.find((b) => b.member_id === me.id);
  const myWaitIndex = queue.findIndex((w) => w.member_id === me.id);
  const myWait = myWaitIndex >= 0 ? queue[myWaitIndex] : null;
  let myPayment: { status: string } | null = null;
  if (mine?.payment_id) {
    const { data } = await supabase.from("payments").select("status").eq("id", mine.payment_id).single();
    myPayment = data;
  }
  const d = parseISODate(date);
  const taken = list.length;
  const closed = !slot.instructor_id;              // v16.1: no teacher = not open for booking
  const cap = closed ? 0 : slot.capacity;
  const extraFrom = closed ? Infinity : cap;      // seats kept from before the teacher was taken off aren't "extra"
  const left = Math.max(0, cap - taken);
  const full = taken >= cap;
  const price = settings?.seat_price_sek ?? 100;
  const deadline = settings?.cancel_deadline_days ?? 1;
  const instructorName = (slot.instructor as unknown as { name: string } | null)?.name ?? null;
  const iTeachThis = slot.instructor_id === me.id;
  const here = `/slot/${slotId}/${date}`;
  const rows = [...list.map((b, i) => ({ b, i })), ...Array.from({ length: left }).map((_, k) => ({ b: null, i: taken + k }))];
  const nameOf = (m: unknown) => (m as { name: string } | null)?.name ?? "Member";
  const fromWaitlistUnpaid = !!mine?.promoted_at && myPayment?.status === "pending";
  const mineOnPass = !!mine?.pass_id && !mine?.payment_id;
  const costText = cover === "pass" ? "with your pass" : `${price} kr`;
  const coverNote = cover === "week_used" ? `This week's ${settings?.pass_twice_per_week ?? 2} pass sessions are used — this one is ${price} kr.`
    : cover === "unpaid" ? `Your monthly pass isn't paid yet — this seat is ${price} kr for now and moves onto the pass once you tap “I have paid” for it.`
    : null;
  const seatsText = closed ? "Not open — no teacher yet" : left > 0 ? `${left} seat${left === 1 ? "" : "s"} left` : taken > cap ? `Full · ${taken - cap} extra` : "Full";
  const noticeText = ok === "cancelled" ? cancelledText(to, cr, later) : undefined;

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href="/" className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Weekly board</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{WEEKDAYS_LONG[slot.weekday - 1]} · {sessionLabel(slot.session)}</h1>
          <div className="muted">{longDate(d)} · {hm(slot.start_time)} – {hm(slot.end_time)}</div>
        </div>
        <Notice error={error} ok={ok} text={noticeText} />

        {slot.whatsapp_url && (
          <a href={slot.whatsapp_url} target="_blank" rel="noopener noreferrer" className="btn line" style={{ gap: 8 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 11.5a8.4 8.4 0 0 1-12.6 7.3L3 21l2.2-5.2A8.5 8.5 0 1 1 21 11.5z" /></svg>
            Open WhatsApp group
          </a>
        )}
        <div className="card person">
          <div className="avatar big">{instructorName ? instructorName[0] : "?"}</div>
          <div>
            <div className="muted small">Teacher this session</div>
            <div className="bold">{instructorName ? `Teacher ${instructorName}` : "Not set yet"}{iTeachThis ? " (you)" : ""}</div>
          </div>
        </div>

        <div>
          <div className="row between"><span className="bold">Seats {taken} / {cap}</span><span className="muted small">{seatsText}{queue.length > 0 ? ` · ${queue.length} waiting` : ""}</span></div>
          {!closed && <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${Math.min(100, (taken / cap) * 100)}%` }} /></div>}
        </div>

        {(!closed || list.length > 0) && <div className="row between">
          <div className="muted small">Who&apos;s coming</div>
          <div className="legend" style={{ gap: 10 }}>
            <span><i className="swatch" style={{ background: "var(--green)", borderRadius: 3 }} />Paid</span>
            <span><i className="swatch" style={{ background: "var(--gold)", borderRadius: 3 }} />Awaiting confirmation</span>
          </div>
        </div>}
        <div className="stack" style={{ gap: 8 }}>
          {rows.map(({ b, i }) =>
            b ? (
              <div key={b.id} className={`card person ${i >= extraFrom ? "extra" : b.member_id === me.id ? (mineOnPass ? "paid" : paymentClass(myPayment?.status)) : ""}`}>
                <div className="avatar">{nameOf(b.member)[0]}</div>
                <div style={{ fontWeight: 600 }}>{nameOf(b.member)}{b.member_id === me.id ? " (you)" : ""}</div>
                {i >= extraFrom ? <PaymentTag extra /> : b.member_id === me.id ? (mineOnPass ? <PassTag /> : <PaymentTag status={myPayment?.status} />) : null}
              </div>
            ) : (
              <div key={`open-${i}`} className="card dashed person"><div className="avatar ghost" /><div>Open seat</div></div>
            )
          )}
        </div>

        {(queue.length > 0 || (!closed && full && !mine && !iTeachThis)) && (
          <>
            <div className="row between" style={{ marginTop: 4 }}>
              <div className="muted small">Waiting list{queue.length > 0 ? ` · ${queue.length}` : ""}</div>
              <div className="muted small">First in line gets a freed seat</div>
            </div>
            <div className="stack" style={{ gap: 8 }}>
              {queue.length === 0 && <div className="card dashed person"><div className="avatar ghost" /><div>Nobody waiting yet</div></div>}
              {queue.map((w, i) => (
                <div key={w.id} className={`card person wait ${w.member_id === me.id ? "mine" : ""}`}>
                  <div className="avatar ordinal">{i + 1}</div>
                  <div style={{ fontWeight: 600 }}>{nameOf(w.member)}{w.member_id === me.id ? " (you)" : ""}</div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="footer">
        {mine ? (
          <>
            {fromWaitlistUnpaid && <div className="notice">This seat came to you from the waiting list — pay to keep it, or decline it (free until you pay).</div>}
            {myPayment?.status === "pending" && (
              <>
                <Link href={`/pay/${mine.id}`} className="btn red">Pay {price} kr with Swish</Link>
                <form action={claimPayment}>
                  <input type="hidden" name="payment_id" value={mine.payment_id ?? ""} />
                  <input type="hidden" name="back" value={here} />
                  <button className="btn line">I have paid already</button>
                </form>
              </>
            )}
            <form action={cancelBooking}>
              <input type="hidden" name="booking_id" value={mine.id} />
              <input type="hidden" name="back" value={here} />
              <button className="btn quiet">{fromWaitlistUnpaid || (mineOnPass && mine.promoted_at) ? "Decline this seat" : "Cancel my seat"}</button>
            </form>
            {mineOnPass && <div className="muted small" style={{ textAlign: "center" }}>Booked with your monthly pass — nothing to pay.</div>}
            {!fromWaitlistUnpaid && <div className="muted small" style={{ textAlign: "center" }}>Free to cancel until {deadline} day{deadline === 1 ? "" : "s"} before{mineOnPass ? "" : " — what you paid comes back as credits"}.{queue.length > 0 ? " Your seat then goes to the waiting list." : ""}</div>}
          </>
        ) : myWait ? (
          <>
            <div className="notice">You are #{myWaitIndex + 1} on the waiting list. When a seat frees up it is yours automatically — {cover === "pass" || cover === "cap" ? "covered by your pass" : `you then pay ${price} kr as usual`}. Check My seats or the WhatsApp group.</div>
            {left > 0 && myWaitIndex < left && (
              <form action={bookSeat}>
                <input type="hidden" name="slot_id" value={slotId} />
                <input type="hidden" name="date" value={date} />
                <SubmitButton className="btn red" pendingText="Booking…">A seat is open — take it · {costText}</SubmitButton>
              </form>
            )}
            <form action={leaveWaitlist}>
              <input type="hidden" name="waitlist_id" value={myWait.id} />
              <input type="hidden" name="back" value={here} />
              <button className="btn quiet">Leave the waiting list</button>
            </form>
          </>
        ) : iTeachThis ? (
          <div className="notice">You&apos;re the teacher for this session — no seat needed.</div>
        ) : closed ? (
          <div className="notice">This session has no teacher yet, so it isn&apos;t open for booking.</div>
        ) : full ? (
          <>
            <form action={joinWaitlist}>
              <input type="hidden" name="slot_id" value={slotId} />
              <input type="hidden" name="date" value={date} />
              <SubmitButton className="btn ink" pendingText="Joining…">Join the waiting list{queue.length > 0 ? ` · #${queue.length + 1}` : ""}</SubmitButton>
            </form>
            <div className="muted small" style={{ textAlign: "center" }}>This session is full. If someone cancels, the first in line gets the seat automatically{cover === "pass" || cover === "cap" ? " — your pass covers it" : ` — and pays ${price} kr then`}. Free to leave the list.</div>
          </>
        ) : cover === "cap" ? (
          <div className="notice">Your pass already holds {settings?.pass_max_upcoming ?? 4} upcoming seats. Cancel one, or book again after one has passed.</div>
        ) : (
          <>
            {coverNote && <div className="notice">{coverNote}</div>}
            <form action={bookSeat}>
              <input type="hidden" name="slot_id" value={slotId} />
              <input type="hidden" name="date" value={date} />
              <SubmitButton className="btn red" pendingText="Booking…">Book this seat · {costText}</SubmitButton>
            </form>
            <div className="muted small" style={{ textAlign: "center" }}>{cover === "pass" ? "Covered by your monthly pass — nothing to pay" : "Swish opens right after you book"}</div>
          </>
        )}
      </div>
    </main>
  );
}
