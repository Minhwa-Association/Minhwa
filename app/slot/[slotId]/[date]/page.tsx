import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hm, isValidISODate, longDate, parseISODate, sessionLabel, WEEKDAYS_LONG } from "@/lib/dates";
import { bookSeat, cancelBooking } from "@/app/actions";
import { ChargeTag, Chevron, Notice } from "@/app/components";

export default async function SlotPage({ params, searchParams }: {
  params: Promise<{ slotId: string; date: string }>;
  searchParams: Promise<{ error?: string; ok?: string }>;
}) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { slotId, date } = await params;
  const { error, ok } = await searchParams;
  if (!isValidISODate(date)) notFound();

  const supabase = await createClient();
  const [{ data: slot }, { data: bookings }, { data: settings }] = await Promise.all([
    supabase.from("slots").select("id, weekday, session, start_time, end_time, capacity, instructor_id, whatsapp_url, instructor:members!slots_instructor_id_fkey(name)").eq("id", slotId).single(),
    supabase.from("bookings").select("id, member_id, created_at, charge_id, member:members(name)").eq("slot_id", slotId).eq("date", date).eq("status", "booked").order("created_at"),
    supabase.from("settings").select("seat_price_sek, cancel_deadline_days").eq("id", 1).single(),
  ]);
  if (!slot) notFound();

  const list = bookings ?? [];
  const mine = list.find((b) => b.member_id === me.id);
  let myCharge: { status: string } | null = null;
  if (mine?.charge_id) {
    const { data } = await supabase.from("charges").select("status").eq("id", mine.charge_id).single();
    myCharge = data;
  }
  const d = parseISODate(date);
  const taken = list.length;
  const cap = slot.capacity;
  const left = Math.max(0, cap - taken);
  const price = settings?.seat_price_sek ?? 100;
  const instructorName = (slot.instructor as unknown as { name: string } | null)?.name ?? null;
  const iTeachThis = slot.instructor_id === me.id;
  const rows = [...list.map((b, i) => ({ b, i })), ...Array.from({ length: left }).map((_, k) => ({ b: null, i: taken + k }))];

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href="/" className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Weekly board</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{WEEKDAYS_LONG[slot.weekday - 1]} · {sessionLabel(slot.session)}</h1>
          <div className="muted">{longDate(d)} · {hm(slot.start_time)} – {hm(slot.end_time)}</div>
        </div>
        <Notice error={error} ok={ok} />

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
          <div className="row between"><span className="bold">Seats {taken} / {cap}</span><span className="muted small">{left > 0 ? `${left} seat${left === 1 ? "" : "s"} left` : taken > cap ? `Full · ${taken - cap} extra` : "Full · extra seats possible"}</span></div>
          <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${Math.min(100, (taken / cap) * 100)}%` }} /></div>
        </div>

        <div className="row between">
          <div className="muted small">Who&apos;s coming</div>
          <div className="legend" style={{ gap: 10 }}>
            <span><i className="swatch" style={{ background: "var(--green)", borderRadius: 3 }} />Paid</span>
            <span><i className="swatch" style={{ background: "var(--gold)", borderRadius: 3 }} />Pending</span>
          </div>
        </div>
        <div className="stack" style={{ gap: 8 }}>
          {rows.map(({ b, i }) =>
            b ? (
              <div key={b.id} className={`card person ${i >= cap ? "extra" : b.member_id === me.id ? (myCharge?.status === "paid" ? "paid" : myCharge?.status === "pending" ? "pending" : "") : ""}`}>
                <div className="avatar">{((b.member as unknown as { name: string } | null)?.name ?? "?")[0]}</div>
                <div style={{ fontWeight: 600 }}>{(b.member as unknown as { name: string } | null)?.name ?? "Member"}{b.member_id === me.id ? " (you)" : ""}</div>
                {i >= cap ? <ChargeTag extra /> : b.member_id === me.id ? <ChargeTag status={myCharge?.status} /> : null}
              </div>
            ) : (
              <div key={`open-${i}`} className="card dashed person"><div className="avatar ghost" /><div>Open seat</div></div>
            )
          )}
        </div>
      </div>

      <div className="footer">
        {mine ? (
          <>
            {myCharge?.status === "unpaid" && <Link href={`/pay/${mine.id}`} className="btn red">Pay {price} kr with Swish</Link>}
            <form action={cancelBooking}>
              <input type="hidden" name="booking_id" value={mine.id} />
              <input type="hidden" name="back" value={`/slot/${slotId}/${date}`} />
              <button className="btn quiet">Cancel my seat</button>
            </form>
            <div className="muted small" style={{ textAlign: "center" }}>Free to cancel until {settings?.cancel_deadline_days ?? 1} day{(settings?.cancel_deadline_days ?? 1) === 1 ? "" : "s"} before.</div>
          </>
        ) : iTeachThis ? (
          <div className="notice">You&apos;re the teacher for this session — no seat needed.</div>
        ) : (
          <>
            <form action={bookSeat}>
              <input type="hidden" name="slot_id" value={slotId} />
              <input type="hidden" name="date" value={date} />
              <button className="btn red">{taken >= cap ? `Book an extra seat · ${price} kr` : `Book this seat · ${price} kr`}</button>
            </form>
            <div className="muted small" style={{ textAlign: "center" }}>Swish opens right after you book</div>
          </>
        )}
      </div>
    </main>
  );
}
