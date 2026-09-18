import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { addDays, isValidISODate, mondayOf, parseISODate, shortDate, toISODate, weekLabel, WEEKDAYS } from "@/lib/dates";
import { Chevron, Notice, TopNav } from "@/app/components";

type Row = {
  slot_id: string; date: string; weekday: number; session: "day" | "evening";
  start_time: string; end_time: string; capacity: number; instructor_name: string | null;
  taken: number; seats_left: number;
};

export default async function BoardPage({ searchParams }: { searchParams: Promise<{ week?: string; error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (me.name === "New member") redirect("/welcome");

  const { week, error, ok } = await searchParams;
  const today = new Date();
  const thisMonday = mondayOf(today);
  const monday = isValidISODate(week) ? mondayOf(parseISODate(week)) : thisMonday;
  const mondayISO = toISODate(monday);

  const supabase = await createClient();
  const [{ data: rows }, { data: settings }, { data: mine }] = await Promise.all([
    supabase.rpc("week_board", { week_start: mondayISO }),
    supabase.from("settings").select("booking_window_weeks").eq("id", 1).single(),
    supabase.from("bookings").select("slot_id, date").eq("member_id", me.id).eq("status", "booked")
      .gte("date", mondayISO).lte("date", toISODate(addDays(monday, 4))),
  ]);
  const board = (rows ?? []) as Row[];
  const mineSet = new Set((mine ?? []).map((b) => `${b.slot_id}|${b.date}`));
  const windowWeeks = settings?.booking_window_weeks ?? 2;
  const lastBookable = addDays(today, windowWeeks * 7);

  const weekOffset = Math.round((monday.getTime() - thisMonday.getTime()) / (7 * 86400000));
  const weekWord = weekOffset === 0 ? "This week" : weekOffset === 1 ? "Next week" : weekOffset < 0 ? "Past week" : `In ${weekOffset} weeks`;
  const todayISO = toISODate(today);

  return (
    <main className="page">
      <div className="topbar">
        <div>
          <h1>Seat booking</h1>
          <div className="muted small">Minhwa Association</div>
        </div>
        <TopNav current="board" isAdmin={me.role === "admin"} />
      </div>

      <div className="stack">
        <Notice error={error} ok={ok} />
        <div className="weeknav">
          <Link className="iconbtn" href={`/?week=${toISODate(addDays(monday, -7))}`} aria-label="Previous week"><Chevron dir="left" /></Link>
          <div style={{ textAlign: "center" }}>
            <div className="bold" style={{ fontSize: 16 }}>{weekLabel(monday)}</div>
            <div className="small" style={{ color: weekOffset === 0 ? "var(--muted)" : "var(--red)", fontWeight: 600 }}>{weekWord}</div>
          </div>
          <Link className="iconbtn" href={`/?week=${toISODate(addDays(monday, 7))}`} aria-label="Next week"><Chevron dir="right" /></Link>
        </div>

        <div className="legend">
          <span><i className="swatch" style={{ background: "var(--green)", border: "1px solid var(--green-line)" }} />Open</span>
          <span><i className="swatch" style={{ background: "var(--pink-pale)", border: "1px solid var(--red-line)" }} />Almost full</span>
          <span><i className="swatch" style={{ background: "var(--red-soft)", border: "1px solid var(--red)" }} />Full</span>
          <span><i className="swatch" style={{ background: "var(--ink)" }} />Member</span>
          <span><i className="swatch" style={{ background: "var(--ink)", border: "1.5px solid var(--red)" }} />Extra</span>
        </div>

        <div className="board">
          {WEEKDAYS.map((name, i) => {
            const date = addDays(monday, i);
            const iso = toISODate(date);
            const cells = board.filter((r) => r.weekday === i + 1);
            return (
              <div className="dayrow" key={name}>
                <div className="daylabel"><b>{name}</b><span className="small muted">{shortDate(date)}</span></div>
                {(["day", "evening"] as const).map((s) => {
                  const r = cells.find((c) => c.session === s);
                  if (!r) return <div key={s} className="cell" />;
                  const status = r.taken >= r.capacity ? "full" : r.taken >= 3 ? "almost" : "";
                  const past = iso < todayISO;
                  const beyond = date > lastBookable;
                  const isMine = mineSet.has(`${r.slot_id}|${iso}`);
                  const n = Math.max(r.capacity, r.taken);
                  const inner = (
                    <>
                      <div className="row between" style={{ alignItems: "baseline" }}>
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{s === "day" ? "Day" : "Evening"} <span style={{ fontWeight: 500, fontSize: 11, opacity: 0.8 }}>{r.start_time.slice(0, 2)}–{r.end_time.slice(0, 2)}</span></span>
                        <span style={{ fontSize: 15, fontWeight: 700 }}>{r.taken}/{r.capacity}</span>
                      </div>
                      <div className="dots" aria-label={`${r.taken} of ${r.capacity} seats taken`}>
                        {Array.from({ length: n }).map((_, k) => (
                          <i key={k} className={`dot ${k >= r.capacity ? "extra" : k < r.taken ? "on" : ""}`} />
                        ))}
                      </div>
                      <div style={{ fontSize: 11, opacity: 0.85 }}>
                        {r.instructor_name ? `Teacher ${r.instructor_name}` : "Teacher not set"}
                        {r.taken > r.capacity ? ` · +${r.taken - r.capacity} extra` : ""}
                        {isMine ? " · you" : ""}
                      </div>
                    </>
                  );
                  const cls = `cell ${status} ${past ? "past" : ""} ${isMine ? "mine" : ""}`;
                  return past || beyond
                    ? <div key={s} className={cls} aria-disabled="true">{inner}</div>
                    : <Link key={s} href={`/slot/${r.slot_id}/${iso}`} className={cls}>{inner}</Link>;
                })}
              </div>
            );
          })}
        </div>
        {monday > lastBookable && <div className="notice">Bookings open {windowWeeks} weeks ahead. This week isn&apos;t open yet.</div>}
      </div>
    </main>
  );
}
