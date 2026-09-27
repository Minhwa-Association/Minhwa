import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseCalendar } from "@/lib/roles";
import { resetCalendarLink } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { CopyButton } from "./CopyButton";

export default async function SubscribePage({ searchParams }: { searchParams: Promise<{ ok?: string; error?: string; reset?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseCalendar(me)) redirect("/");
  const { ok, error, reset } = await searchParams;
  const supabase = await createClient();
  const { data: token, error: tokErr } = await supabase.rpc("my_calendar_token");
  const host = (await headers()).get("host") ?? "app.minhwa.org";
  const httpsUrl = `https://${host}/cal/${token}.ics`;
  const webcalUrl = `webcal://${host}/cal/${token}.ics`;

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Phone calendar</h1><div className="muted small"><Link href="/calendar">← Calendar</Link></div></div>
        <TopNav current="calendar" me={me} />
      </div>
      <div className="stack">
        <Notice error={error ?? tokErr?.message} ok={ok} />
        <div className="card stack" style={{ padding: 18 }}>
          <h2>Your personal link</h2>
          <div className="muted small">
            Add it once — the association&apos;s events then appear in your own calendar app and update by themselves (within about an hour).
            The link is personal (it shows what you may see). Don&apos;t forward it.
          </div>
          {token && (
            <>
              <a href={webcalUrl} className="btn ink">Add to Apple Calendar (iPhone / Mac)</a>
              <div className="linkbox">{httpsUrl}</div>
              <div className="row" style={{ gap: 8 }}>
                <CopyButton text={httpsUrl} />
              </div>
            </>
          )}
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <h2 style={{ fontSize: 18 }}>Google Calendar (Android)</h2>
          <ol className="steps">
            <li>Copy the link above.</li>
            <li>On a computer, open calendar.google.com → next to &ldquo;Other calendars&rdquo; press <b>+</b> → <b>From URL</b>.</li>
            <li>Paste the link → <b>Add calendar</b>. It then shows on your phone too.</li>
          </ol>
        </div>

        <div className="card stack" style={{ padding: 16 }}>
          <div className="bold">Shared the link by mistake?</div>
          <div className="muted small">Make a new one. The old link stops working right away; add the new one to your phone again.</div>
          {reset === "1" ? (
            <form action={resetCalendarLink} className="row" style={{ gap: 8 }}>
              <button className="btn red sm">Yes, make a new link</button>
              <Link href="/calendar/subscribe" className="btn quiet sm">Cancel</Link>
            </form>
          ) : (
            <Link href="/calendar/subscribe?reset=1" className="btn line sm">New link…</Link>
          )}
        </div>
      </div>
    </main>
  );
}
