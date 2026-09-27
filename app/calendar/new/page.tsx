import Link from "next/link";
import { redirect } from "next/navigation";
import { currentMember } from "@/lib/supabase/server";
import { canUseCalendar } from "@/lib/roles";
import { todayStockholm } from "@/lib/dates";
import { createEvent } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { EventForm } from "@/app/calendar/EventForm";

export default async function NewEventPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseCalendar(me)) redirect("/");
  const { error } = await searchParams;

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>New event</h1><div className="muted small"><Link href="/calendar">← Calendar</Link></div></div>
        <TopNav current="calendar" me={me} />
      </div>
      <div className="stack">
        <Notice error={error} />
        <EventForm action={createEvent} submitLabel="Add event" defaultDate={todayStockholm()} />
      </div>
    </main>
  );
}
