import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hasRole } from "@/lib/roles";
import { dayShort, monthYear, parseISODate, todayStockholm } from "@/lib/dates";
import { audienceLabel, isPast, isToday, whenLabel, type EventRow } from "@/lib/calendar";
import { Notice, TopNav } from "@/app/components";

export default async function CalendarPage({ searchParams }: { searchParams: Promise<{ past?: string; error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { past, error, ok } = await searchParams;
  const showPast = past === "1";
  const canEdit = hasRole(me, "crew") || hasRole(me, "admin");
  const todayISO = todayStockholm();

  const supabase = await createClient();
  const query = supabase.from("events").select("*");
  const { data } = showPast
    ? await query.lt("date", todayISO).order("date", { ascending: false }).order("start_time", { ascending: false }).limit(60)
    : await query.or(`date.gte.${todayISO},end_date.gte.${todayISO}`).order("date").order("start_time", { nullsFirst: true });
  const events = (data ?? []) as EventRow[];

  // group by month
  const groups: { key: string; label: string; items: EventRow[] }[] = [];
  for (const e of events) {
    const key = e.date.slice(0, 7);
    let g = groups.find((x) => x.key === key);
    if (!g) { g = { key, label: monthYear(parseISODate(e.date)), items: [] }; groups.push(g); }
    g.items.push(e);
  }

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Calendar</h1><div className="muted small">Activities of the Minhwa Association</div></div>
        <TopNav current="calendar" isAdmin={hasRole(me, "admin")} />
      </div>

      <div className="stack">
        <Notice error={error} ok={ok} />

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          {canEdit && <Link href="/calendar/new" className="btn ink sm">+ New event</Link>}
          <Link href="/calendar/subscribe" className="btn line sm">Add to my phone calendar</Link>
          <Link href={showPast ? "/calendar" : "/calendar?past=1"} className="btn quiet sm" style={{ marginLeft: "auto" }}>
            {showPast ? "Upcoming →" : "Past events"}
          </Link>
        </div>

        {events.length === 0 && (
          <div className="card dashed" style={{ padding: 24, textAlign: "center" }}>
            {showPast ? "No past events." : canEdit ? "Nothing planned yet. Add the first event." : "Nothing planned yet."}
          </div>
        )}

        {groups.map((g) => (
          <section key={g.key} className="stack" style={{ gap: 8 }}>
            <div className="monthhead">{g.label}</div>
            {g.items.map((e) => {
              const d = parseISODate(e.date);
              const aud = audienceLabel(e.audience);
              return (
                <Link key={e.id} href={`/calendar/${e.id}`} className={`card event ${isToday(e, todayISO) ? "today" : ""} ${isPast(e, todayISO) ? "past" : ""}`}>
                  <div className="datebox"><b>{d.getDate()}</b><span>{dayShort(d)}</span></div>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="title">{e.title}</div>
                    <div className="meta">{whenLabel(e)}{e.location ? ` · ${e.location}` : ""}</div>
                    {aud && <div style={{ marginTop: 6 }}><span className="tag aud">{aud}</span></div>}
                    {e.notes && <div className="notes muted">{e.notes}</div>}
                  </div>
                </Link>
              );
            })}
          </section>
        ))}
      </div>
    </main>
  );
}
