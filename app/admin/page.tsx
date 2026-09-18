import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { addDays, isValidISODate, mondayOf, parseISODate, shortDate, toISODate, weekLabel, WEEKDAYS_LONG } from "@/lib/dates";
import { confirmPaid, cancelBooking } from "@/app/actions";
import { Chevron, Notice, TopNav } from "@/app/components";

type Booking = { id: string; slot_id: string; date: string; member_id: string; created_at: string; member: { name: string } | null; charge: { id: string; status: string } | null };
type Slot = { id: string; weekday: number; session: "day" | "evening"; capacity: number; instructor: { name: string } | null };

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ week?: string; error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { week, error, ok } = await searchParams;
  const monday = isValidISODate(week) ? mondayOf(parseISODate(week)) : mondayOf(new Date());
  const mondayISO = toISODate(monday);
  const fridayISO = toISODate(addDays(monday, 4));
  const back = `/admin?week=${mondayISO}`;

  const supabase = await createClient();
  const [{ data: slots }, { data: bookings }, { data: settings }] = await Promise.all([
    supabase.from("slots").select("id, weekday, session, capacity, instructor:members!slots_instructor_id_fkey(name)").order("weekday").order("session"),
    supabase.from("bookings").select("id, slot_id, date, member_id, created_at, member:members(name), charge:charges(id, status)")
      .eq("status", "booked").gte("date", mondayISO).lte("date", fridayISO).order("created_at"),
    supabase.from("settings").select("seat_price_sek, swish_number").eq("id", 1).single(),
  ]);
  const S = (slots ?? []) as unknown as Slot[];
  const B = (bookings ?? []) as unknown as Booking[];

  const cell = (weekday: number, session: "day" | "evening") => {
    const slot = S.find((s) => s.weekday === weekday && s.session === session);
    if (!slot) return null;
    const date = toISODate(addDays(monday, weekday - 1));
    const list = B.filter((b) => b.slot_id === slot.id && b.date === date);
    const full = list.length >= slot.capacity;
    return (
      <div className={`acell ${full ? "full" : ""}`} key={slot.id + date}>
        <div className="row between" style={{ alignItems: "baseline" }}>
          <span className="muted small">{slot.instructor?.name ? `Teacher ${slot.instructor.name}` : "No teacher"}</span>
          <span className="bold" style={{ fontSize: 14 }}>{list.length}/{slot.capacity}</span>
        </div>
        {list.map((b, i) => {
          const st = b.charge?.status ?? "unpaid";
          const extra = i >= slot.capacity;
          const cls = extra ? "extra" : st === "paid" ? "paid" : st === "pending" ? "pending" : "";
          const label = st === "paid" ? "✓" : st === "pending" ? "Pending" : "Unpaid";
          return (
            <div key={b.id} className={`aperson ${cls}`} style={{ cursor: "default" }}>
              <span>{b.member?.name ?? "Member"}</span>
              <span className="row" style={{ gap: 6 }}>
                <small>{label}{extra ? " · extra" : ""}</small>
                {st !== "paid" && b.charge && (
                  <form action={confirmPaid}>
                    <input type="hidden" name="charge_id" value={b.charge.id} />
                    <input type="hidden" name="back" value={back} />
                    <button className="btn line sm" style={{ minHeight: 28, padding: "0 8px", fontSize: 12 }} title="Mark as paid">Mark paid</button>
                  </form>
                )}
                <form action={cancelBooking}>
                  <input type="hidden" name="booking_id" value={b.id} />
                  <input type="hidden" name="back" value={back} />
                  <button className="btn quiet sm" style={{ minHeight: 28, padding: "0 6px", fontSize: 12 }} title="Remove from this session" aria-label="Remove booking">×</button>
                </form>
              </span>
            </div>
          );
        })}
        {Array.from({ length: Math.max(0, slot.capacity - list.length) }).map((_, k) => (
          <div key={k} className="aperson empty"><span>Open seat</span></div>
        ))}
      </div>
    );
  };

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Weekly board · Admin</h1><div className="muted small">Mark payments as they arrive on Swish. Full slots still take extra bookings (shown in navy).</div></div>
        <TopNav current="admin" isAdmin />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Notice error={error} ok={ok} />
        <div className="row between" style={{ flexWrap: "wrap", gap: 12 }}>
          <div className="weeknav" style={{ width: "auto", gap: 4 }}>
            <Link className="iconbtn" href={`/admin?week=${toISODate(addDays(monday, -7))}`} aria-label="Previous week"><Chevron dir="left" /></Link>
            <div className="bold" style={{ padding: "0 12px", fontSize: 16 }}>{weekLabel(monday)}</div>
            <Link className="iconbtn" href={`/admin?week=${toISODate(addDays(monday, 7))}`} aria-label="Next week"><Chevron dir="right" /></Link>
          </div>
          <div className="row">
            <Link href="/admin/settings" className="pill">Settings & teachers</Link>
            <Link href="/" className="pill">Member view</Link>
          </div>
        </div>

        <div className="admingrid">
          <div />
          {WEEKDAYS_LONG.map((d, i) => (
            <div className="adminhead" key={d}><b>{d}</b><span className="muted small">{shortDate(addDays(monday, i))}</span></div>
          ))}
          <div className="rowlabel"><div className="bold">Day</div><div className="muted small">10:00 – 16:00</div></div>
          {[1, 2, 3, 4, 5].map((w) => cell(w, "day") ?? <div key={`d${w}`} />)}
          <div className="rowlabel"><div className="bold">Evening</div><div className="muted small">17:00 – 20:00</div></div>
          {[1, 2, 3, 4, 5].map((w) => cell(w, "evening") ?? <div key={`e${w}`} />)}
        </div>

        <div className="legend">
          <span><i className="swatch" style={{ background: "var(--green)", borderRadius: 4 }} />Paid</span>
          <span><i className="swatch" style={{ background: "var(--gold)", borderRadius: 4 }} />Awaiting confirmation</span>
          <span><i className="swatch" style={{ border: "1.5px dashed var(--dash)", borderRadius: 4 }} />Open seat</span>
          <span style={{ marginLeft: "auto" }}>{settings?.seat_price_sek} kr per session · Swish {settings?.swish_number}</span>
        </div>
      </div>
    </main>
  );
}
