import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseCalendar, hasRole } from "@/lib/roles";
import { deleteEvent, updateEvent } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { EventForm } from "@/app/calendar/EventForm";
import type { EventRow } from "@/lib/calendar";

export default async function EditEventPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ error?: string; confirm?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { id } = await params;
  if (!canUseCalendar(me)) redirect("/");
  const { error, confirm } = await searchParams;
  const supabase = await createClient();
  const { data } = await supabase.from("events").select("*").eq("id", id).maybeSingle();
  if (!data) notFound();
  const e = data as EventRow;

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Edit event</h1><div className="muted small"><Link href={`/calendar/${e.id}`}>← Back to the event</Link></div></div>
        <TopNav current="calendar" isAdmin={hasRole(me, "admin")} showCalendar />
      </div>
      <div className="stack">
        <Notice error={error} />
        <EventForm action={updateEvent} event={e} submitLabel="Save changes" />

        <div className="card stack" style={{ padding: 16 }}>
          <div className="bold">Delete this event</div>
          <div className="muted small">It disappears from the app and from everyone&apos;s phone calendar at their next refresh.</div>
          {confirm === "1" ? (
            <form action={deleteEvent} className="row" style={{ gap: 8 }}>
              <input type="hidden" name="event_id" value={e.id} />
              <button className="btn red sm">Yes, delete &ldquo;{e.title}&rdquo;</button>
              <Link href={`/calendar/${e.id}/edit`} className="btn quiet sm">Keep it</Link>
            </form>
          ) : (
            <Link href={`/calendar/${e.id}/edit?confirm=1`} className="btn line sm" style={{ color: "var(--red)" }}>Delete…</Link>
          )}
        </div>
      </div>
    </main>
  );
}
