import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hasRole } from "@/lib/roles";
import { dayShort, longDate, parseISODate, todayStockholm } from "@/lib/dates";
import { audienceLabel, isPast, whenLabel, type EventRow } from "@/lib/calendar";
import { Notice, TopNav } from "@/app/components";

export default async function EventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ ok?: string; error?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { id } = await params;
  const { ok, error } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("events").select("*, creator:members!events_created_by_fkey(name)").eq("id", id).maybeSingle();
  if (!data) notFound();
  const e = data as unknown as EventRow & { creator: { name: string } | null };
  const canEdit = hasRole(me, "crew") || hasRole(me, "admin");
  const d = parseISODate(e.date);
  const aud = audienceLabel(e.audience);
  const todayISO = todayStockholm();

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Event</h1><div className="muted small"><Link href="/calendar">← Calendar</Link></div></div>
        <TopNav current="calendar" isAdmin={hasRole(me, "admin")} />
      </div>
      <div className="stack">
        <Notice error={error} ok={ok} />
        <div className={`card event ${isPast(e, todayISO) ? "past" : ""}`} style={{ padding: 18 }}>
          <div className="datebox"><b>{d.getDate()}</b><span>{dayShort(d)}</span></div>
          <div className="grow" style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: 22 }}>{e.title}</h2>
            <div className="meta" style={{ fontSize: 14, marginTop: 6 }}>{longDate(d)}</div>
            <div className="meta" style={{ fontSize: 14 }}>{whenLabel(e)}</div>
            {e.location && <div className="meta" style={{ fontSize: 14 }}>{e.location}</div>}
            <div className="row" style={{ gap: 6, marginTop: 10, flexWrap: "wrap" }}>
              <span className="tag aud">{aud ?? "Everyone"}</span>
              {e.creator?.name && <span className="muted small">added by {e.creator.name}</span>}
            </div>
          </div>
        </div>
        {e.notes && <div className="card prewrap" style={{ padding: 16, fontSize: 14 }}>{e.notes}</div>}
        {canEdit && <Link href={`/calendar/${e.id}/edit`} className="btn line">Edit event</Link>}
      </div>
    </main>
  );
}
