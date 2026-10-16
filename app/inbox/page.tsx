import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseInbox } from "@/lib/roles";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { ago, displayName, igWindowLeftMs, leftText, type ThreadRow } from "@/lib/comms/types";
import { ChannelTag, InboxNav } from "./InboxNav";
import { summariseNow } from "./actions";

type Q = { error?: string; ok?: string };
type Task = { id: string; title: string; due_on: string | null; owner_id: string | null; owner: { name: string } | null; source_thread_id: string | null };
type Digest = { id: string; text: string; since: string; created_at: string; stats: { threads?: number; open?: number; notices?: number } };

/** Inbox → Overview: what is going on, what needs an answer, what is on the list. (v19) */
export default async function InboxOverview({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseInbox(me)) redirect("/");
  const q = await searchParams;
  const supabase = await createClient();
  const dayStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data: open }, { data: tasks }, { data: digest }, { count: suggested }, { data: today }, { count: unread }] = await Promise.all([
    supabase.from("comms_threads").select("*").eq("status", "open").neq("topic", "notice").order("last_in_at", { ascending: true, nullsFirst: false }).limit(30),
    supabase.from("comms_tasks").select("id, title, due_on, owner_id, source_thread_id, owner:members!comms_tasks_owner_id_fkey(name)").eq("status", "open").order("due_on", { ascending: true, nullsFirst: false }).order("created_at").limit(12),
    supabase.from("comms_digests").select("id, text, since, created_at, stats").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("comms_tasks").select("id", { count: "exact", head: true }).eq("status", "suggested"),
    supabase.from("comms_messages").select("channel, direction, thread:comms_threads!comms_messages_thread_id_fkey(topic)").gte("sent_at", dayStart),
    supabase.from("comms_threads").select("id", { count: "exact", head: true }).gt("unread", 0),
  ]);
  const O = (open ?? []) as ThreadRow[];
  const T = (tasks ?? []) as unknown as Task[];
  const D = digest as Digest | null;
  const now = Date.now();
  const todayRows = (today ?? []) as unknown as { channel: string; direction: string; thread: { topic: string } | { topic: string }[] | null }[];
  const topicOf = (r: (typeof todayRows)[number]) => (Array.isArray(r.thread) ? r.thread[0]?.topic : r.thread?.topic) ?? "";
  const n = { ig: todayRows.filter((r) => r.channel === "instagram" && r.direction === "in").length, mail: todayRows.filter((r) => r.channel === "email" && r.direction === "in" && topicOf(r) !== "notice").length, notice: todayRows.filter((r) => topicOf(r) === "notice").length, out: todayRows.filter((r) => r.direction === "out").length };
  const mine = T.filter((t) => t.owner_id === me.id);
  const others = T.filter((t) => t.owner_id !== me.id);

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Inbox</h1><div className="muted small">Instagram DMs and the association&rsquo;s mail in one place. Open = they wrote last. Claude sorts and suggests; people decide.</div></div>
        <TopNav current="inbox" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <InboxNav current="overview" counts={{ unread: unread ?? 0, suggested: suggested ?? 0 }} />
        <Notice error={q.error} ok={q.ok} text={q.ok === "digest" ? "Summary written." : undefined} />

        <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="pill">Last 24 h: {n.ig} Instagram · {n.mail} mail · {n.out} sent</span>
          {n.notice > 0 && <span className="pill">{n.notice} notification{n.notice === 1 ? "" : "s"}</span>}
          {(suggested ?? 0) > 0 && <Link href="/inbox/tasks" className="pill">{suggested} suggested task{suggested === 1 ? "" : "s"} to approve</Link>}
        </div>

        <div className="inboxcols">
          <div className="stack" style={{ gap: 16 }}>
            <div className="card stack" style={{ padding: 18 }}>
              <div className="row between" style={{ alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
                <h2>What is going on</h2>
                <form action={summariseNow} className="row" style={{ gap: 6 }}>
                  <select name="lang" defaultValue="en" className="sm" aria-label="Language"><option value="en">English</option><option value="ko">한국어</option><option value="sv">Svenska</option></select>
                  <SubmitButton className="btn line sm" pendingText="Writing…">Summarise now</SubmitButton>
                </form>
              </div>
              {D ? (
                <>
                  <div className="prewrap" style={{ lineHeight: 1.5 }}>{D.text}</div>
                  <div className="muted small">Written {ago(D.created_at, now)} · covers since {D.since.slice(0, 16).replace("T", " ")} · {D.stats?.threads ?? 0} conversations, {D.stats?.open ?? 0} open{D.stats?.notices ? `, ${D.stats.notices} notifications` : ""}</div>
                </>
              ) : (
                <div className="muted">No summary yet. &ldquo;Summarise now&rdquo; asks Claude to write one from the last three days.</div>
              )}
            </div>

            <div className="card stack" style={{ padding: 18 }}>
              <h2>Needs an answer <span className="muted small">({O.length})</span></h2>
              {O.length === 0 && <div className="muted">Nothing is waiting on us.</div>}
              {O.map((t) => {
                const left = t.channel === "instagram" ? igWindowLeftMs(t.last_in_at, now) : null;
                return (
                  <Link key={t.id} href={`/inbox/messages?t=${t.id}`} className="threadrow">
                    <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                      <ChannelTag channel={t.channel} />
                      <span className="bold">{displayName(t)}</span>
                      {t.member_id && <span className="tag">member</span>}
                      <span className="muted small" style={{ marginLeft: "auto" }}>{ago(t.last_in_at ?? t.last_message_at, now)}</span>
                    </div>
                    <div className="small" style={{ marginTop: 2 }}>{t.gist ?? t.subject ?? t.last_preview ?? ""}</div>
                    {left !== null && <div className={`small ${left <= 0 ? "err-text" : "muted"}`}>{left <= 0 ? "Instagram window closed — answer from the app on the phone" : `Instagram: ${leftText(left)}`}</div>}
                  </Link>
                );
              })}
            </div>
          </div>

          <div className="card stack" style={{ padding: 18 }}>
            <div className="row between" style={{ alignItems: "baseline" }}><h2>Tasks</h2><Link href="/inbox/tasks" className="small" style={{ fontWeight: 600 }}>All tasks</Link></div>
            {T.length === 0 && <div className="muted">Nothing on the list.</div>}
            {mine.length > 0 && <div className="muted small" style={{ fontWeight: 600 }}>Mine</div>}
            {mine.map((t) => <TaskLine key={t.id} t={t} />)}
            {others.length > 0 && <div className="muted small" style={{ fontWeight: 600, marginTop: mine.length ? 8 : 0 }}>Others</div>}
            {others.map((t) => <TaskLine key={t.id} t={t} />)}
          </div>
        </div>
      </div>
    </main>
  );
}

function TaskLine({ t }: { t: Task }) {
  return (
    <div className="row between" style={{ gap: 8, alignItems: "baseline" }}>
      <span>{t.title}{t.source_thread_id ? <Link href={`/inbox/messages?t=${t.source_thread_id}`} className="small muted" title="Open the conversation"> ↗</Link> : null}</span>
      <span className="muted small" style={{ whiteSpace: "nowrap" }}>{t.owner?.name ?? "—"}{t.due_on ? ` · ${t.due_on.slice(5)}` : ""}</span>
    </div>
  );
}
