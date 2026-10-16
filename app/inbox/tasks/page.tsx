import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseInbox } from "@/lib/roles";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { ago, type TaskRow } from "@/lib/comms/types";
import { InboxNav } from "../InboxNav";
import { addTask, setTaskStatus, updateTask } from "../actions";

type Q = { error?: string; ok?: string };
type Task = TaskRow & { owner: { name: string } | null; thread: { counterpart_name: string | null; counterpart_handle: string | null; subject: string | null; channel: string } | null };
type Member = { id: string; name: string; roles: string[] | null; inbox_access: boolean | null };

function okText(q: Q): string | undefined {
  switch (q.ok) {
    case "task": return "Task added.";
    case "open": return "Approved — it is on the list now.";
    case "done": return "Done.";
    case "dropped": return "Dropped.";
    case "saved": return "Saved.";
    default: return undefined;
  }
}

/** Inbox → Tasks: the manager's list. Claude's suggestions wait here until a person approves them. (v19) */
export default async function TasksPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseInbox(me)) redirect("/");
  const q = await searchParams;
  const supabase = await createClient();
  const sel = "*, owner:members!comms_tasks_owner_id_fkey(name), thread:comms_threads!comms_tasks_source_thread_id_fkey(counterpart_name, counterpart_handle, subject, channel)";
  const [{ data: suggested }, { data: open }, { data: done }, { data: members }, { count: unread }] = await Promise.all([
    supabase.from("comms_tasks").select(sel).eq("status", "suggested").order("created_at", { ascending: false }).limit(50),
    supabase.from("comms_tasks").select(sel).eq("status", "open").order("due_on", { ascending: true, nullsFirst: false }).order("created_at").limit(200),
    supabase.from("comms_tasks").select(sel).in("status", ["done", "dropped"]).order("done_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false }).limit(30),
    supabase.from("members").select("id, name, roles, inbox_access").eq("active", true).order("name"),
    supabase.from("comms_threads").select("id", { count: "exact", head: true }).gt("unread", 0),
  ]);
  const S = (suggested ?? []) as unknown as Task[];
  const O = (open ?? []) as unknown as Task[];
  const D = (done ?? []) as unknown as Task[];
  const people = ((members ?? []) as Member[]).filter((m) => canUseInbox(m));
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const who = (t: Task) => t.thread ? (t.thread.counterpart_name ?? t.thread.counterpart_handle ?? t.thread.subject ?? t.thread.channel) : null;

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Inbox · Tasks</h1><div className="muted small">What the manager has to do. Suggestions come from Claude reading the messages — approve or drop them; nothing is on the list until a person says so.</div></div>
        <TopNav current="inbox" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <InboxNav current="tasks" counts={{ unread: unread ?? 0, suggested: S.length }} />
        <Notice error={q.error} ok={q.ok} text={okText(q)} />

        <div className="card stack" style={{ padding: 18 }}>
          <h2>New task</h2>
          <form action={addTask} className="cform">
            <input type="hidden" name="from" value="tasks" />
            <input name="title" placeholder="What has to be done" maxLength={140} required />
            <select name="owner_id" defaultValue={me.id} aria-label="Owner">{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <input type="date" name="due_on" aria-label="Due" />
            <SubmitButton className="btn" pendingText="…">Add</SubmitButton>
            <input name="detail" placeholder="Detail (optional)" maxLength={600} style={{ gridColumn: "1 / -1" }} />
          </form>
        </div>

        {S.length > 0 && (
          <div className="card stack" style={{ padding: 18 }}>
            <h2>Suggested <span className="muted small">({S.length}) — from the messages, waiting for a yes</span></h2>
            {S.map((t) => (
              <div key={t.id} className="taskrow sugg">
                <div className="grow">
                  <div>{t.title}</div>
                  {t.detail && <div className="muted small">{t.detail}</div>}
                  <div className="muted small">{who(t) ? <Link href={`/inbox/messages?t=${t.source_thread_id}`}>{who(t)} ↗</Link> : null} · suggested {ago(t.created_at, now)}</div>
                </div>
                <form action={setTaskStatus}><input type="hidden" name="task_id" value={t.id} /><input type="hidden" name="status" value="open" /><button className="btn sm">Approve</button></form>
                <form action={setTaskStatus}><input type="hidden" name="task_id" value={t.id} /><input type="hidden" name="status" value="dropped" /><button className="btn quiet sm">Drop</button></form>
              </div>
            ))}
          </div>
        )}

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Open <span className="muted small">({O.length})</span></h2>
          {O.length === 0 && <div className="muted">Nothing on the list.</div>}
          {O.map((t) => (
            <form key={t.id} action={updateTask} className={`taskrow ${t.due_on && t.due_on < today ? "late" : ""}`}>
              <input type="hidden" name="task_id" value={t.id} />
              <div className="grow">
                <input name="title" defaultValue={t.title} maxLength={140} className="grow" style={{ width: "100%" }} />
                {t.detail && <div className="muted small">{t.detail}</div>}
                {who(t) && <div className="muted small"><Link href={`/inbox/messages?t=${t.source_thread_id}`}>{who(t)} ↗</Link></div>}
              </div>
              <select name="owner_id" defaultValue={t.owner_id ?? ""} className="sm" aria-label="Owner"><option value="">Nobody</option>{people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <input type="date" name="due_on" defaultValue={t.due_on ?? ""} className="sm" aria-label="Due" />
              <button className="btn line sm">Save</button>
              <button className="btn sm" formAction={setTaskStatus} name="status" value="done" title="Done">✓</button>
            </form>
          ))}
        </div>

        {D.length > 0 && (
          <div className="card stack" style={{ padding: 18 }}>
            <h2>Finished <span className="muted small">(last {D.length})</span></h2>
            {D.map((t) => (
              <div key={t.id} className="row between small" style={{ gap: 8 }}>
                <span className={t.status === "dropped" ? "muted" : ""}>{t.status === "dropped" ? "dropped · " : ""}{t.title}</span>
                <span className="muted" style={{ whiteSpace: "nowrap" }}>{t.owner?.name ?? ""}{t.done_at ? ` · ${ago(t.done_at, now)}` : ""}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
