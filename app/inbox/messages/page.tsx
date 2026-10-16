import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseInbox } from "@/lib/roles";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { ago, displayName, igWindowLeftMs, leftText, STATUSES, TOPICS, type MessageRow, type TemplateRow, type ThreadRow } from "@/lib/comms/types";
import { ChannelTag, InboxNav } from "../InboxNav";
import { addTask, assignThread, linkThreadMember, replyInstagram, setThreadGist, setThreadStatus, setThreadTopic } from "../actions";
import { ReplyBox } from "./ReplyBox";

type Q = { t?: string; channel?: string; status?: string; topic?: string; error?: string; ok?: string };
type Member = { id: string; name: string; roles: string[] | null; inbox_access: boolean | null; email: string | null; instagram: string | null };
type Booking = { date: string; status: string; slot: { session: string } | { session: string }[] | null };

function okText(q: Q): string | undefined {
  switch (q.ok) {
    case "sent": return "Sent.";
    case "done": return "Marked done. A new message from them reopens it.";
    case "task": return "Task added.";
    case "saved": return "Saved.";
    default: return undefined;
  }
}

/** Inbox → Messages: the list on the left, one conversation on the right. (v19) */
export default async function MessagesPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseInbox(me)) redirect("/");
  const q = await searchParams;
  const supabase = await createClient();
  const statusFilter = q.status === "done" ? "done" : q.status === "all" ? "all" : q.status === "waiting" ? "waiting" : q.status === "open" ? "open" : "active";

  let list = supabase.from("comms_threads").select("*").order("last_message_at", { ascending: false }).limit(120);
  if (statusFilter === "active") list = list.in("status", ["open", "waiting"]);
  else if (statusFilter !== "all") list = list.eq("status", statusFilter);
  if (q.channel === "instagram" || q.channel === "email") list = list.eq("channel", q.channel);
  if (q.topic && TOPICS.some((x) => x.key === q.topic)) list = list.eq("topic", q.topic);
  else if (statusFilter === "active") list = list.neq("topic", "notice");

  const [{ data: threads }, { data: members }, { data: templates }, { count: suggested }] = await Promise.all([
    list,
    supabase.from("members").select("id, name, roles, inbox_access, email, instagram").eq("active", true).order("name"),
    supabase.from("comms_templates").select("*").order("sort").order("title"),
    supabase.from("comms_tasks").select("id", { count: "exact", head: true }).eq("status", "suggested"),
  ]);
  const T = (threads ?? []) as ThreadRow[];
  const M = (members ?? []) as Member[];
  const inboxPeople = M.filter((m) => canUseInbox(m));
  const now = Date.now();

  const selected = q.t ? (T.find((t) => t.id === q.t) ?? ((await supabase.from("comms_threads").select("*").eq("id", q.t).maybeSingle()).data as ThreadRow | null)) : null;
  let messages: MessageRow[] = [];
  let tasks: { id: string; title: string; status: string }[] = [];
  let bookings: Booking[] = [];
  if (selected) {
    const [{ data: msgs }, { data: tk }] = await Promise.all([
      supabase.from("comms_messages").select("id, thread_id, channel, external_id, direction, from_name, from_handle, to_handle, subject, text, html, attachments, is_echo, sent_by, sent_at").eq("thread_id", selected.id).order("sent_at").limit(200),
      supabase.from("comms_tasks").select("id, title, status").eq("source_thread_id", selected.id).in("status", ["suggested", "open"]).order("created_at"),
    ]);
    messages = (msgs ?? []) as MessageRow[];
    tasks = tk ?? [];
    if (selected.unread > 0) await supabase.rpc("comms_mark_read", { p_thread: selected.id });
    if (selected.member_id) {
      const { data: b } = await supabase.from("bookings").select("date, status, slot:slots(session)").eq("member_id", selected.member_id).gte("date", new Date().toISOString().slice(0, 10)).order("date").limit(5);
      bookings = (b ?? []) as unknown as Booking[];
    }
  }
  const filters = { channel: q.channel ?? "", status_filter: q.status ?? "", topic_filter: q.topic ?? "" };
  const href = (patch: Partial<Q>) => {
    const p = new URLSearchParams();
    const merged = { t: q.t, channel: q.channel, status: q.status, topic: q.topic, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
    const s = p.toString();
    return `/inbox/messages${s ? `?${s}` : ""}`;
  };
  const tmpl = (templates ?? []) as TemplateRow[];
  const igLeft = selected?.channel === "instagram" ? igWindowLeftMs(selected.last_in_at, now) : null;
  const linkedMember = selected?.member_id ? M.find((m) => m.id === selected.member_id) : null;
  const unread = T.reduce((n, t) => n + (t.unread > 0 ? 1 : 0), 0);

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Inbox · Messages</h1><div className="muted small">Open = they wrote last · Waiting = we answered · Done = finished. Instagram replies go from here (within 24 h of their message); mail is answered in Gmail for now.</div></div>
        <TopNav current="inbox" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <InboxNav current="messages" counts={{ unread, suggested: suggested ?? 0 }} />
        <Notice error={q.error} ok={q.ok} text={okText(q)} />

        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {[["", "Active"], ["open", "Open"], ["waiting", "Waiting"], ["done", "Done"], ["all", "All"]].map(([v, l]) => (
            <Link key={v} href={href({ status: v || undefined, t: undefined })} className={`pill ${(q.status ?? "") === v ? "active" : ""}`}>{l}</Link>
          ))}
          <span className="divider" />
          {[["", "Both"], ["instagram", "Instagram"], ["email", "Mail"]].map(([v, l]) => (
            <Link key={v} href={href({ channel: v || undefined, t: undefined })} className={`pill ${(q.channel ?? "") === v ? "active" : ""}`}>{l}</Link>
          ))}
          <span className="divider" />
          <form method="get" action="/inbox/messages" className="row" style={{ gap: 6 }}>
            {q.status && <input type="hidden" name="status" value={q.status} />}
            {q.channel && <input type="hidden" name="channel" value={q.channel} />}
            <select name="topic" defaultValue={q.topic ?? ""} className="sm" aria-label="Topic">
              <option value="">Every topic</option>
              {TOPICS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
            </select>
            <button className="btn line sm">Show</button>
          </form>
        </div>

        <div className={`inboxgrid ${selected ? "has-thread" : ""}`}>
          <div className="threadlist card" style={{ padding: 8 }}>
            {T.length === 0 && <div className="muted" style={{ padding: 12 }}>Nothing here.</div>}
            {T.map((t) => (
              <Link key={t.id} href={href({ t: t.id })} className={`threadrow ${selected?.id === t.id ? "active" : ""} ${t.unread > 0 ? "unread" : ""}`}>
                <div className="row" style={{ gap: 8, alignItems: "baseline" }}>
                  <ChannelTag channel={t.channel} />
                  <span className="bold" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{displayName(t)}</span>
                  {t.unread > 0 && <span className="count">{t.unread}</span>}
                  <span className="muted small" style={{ marginLeft: "auto", whiteSpace: "nowrap" }}>{ago(t.last_message_at, now)}</span>
                </div>
                <div className="small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.subject ? `${t.subject} — ` : ""}{t.gist ?? t.last_preview ?? ""}</div>
                <div className="muted small">{STATUSES.find((s) => s.key === t.status)?.label}{t.topic !== "unsorted" ? ` · ${TOPICS.find((x) => x.key === t.topic)?.label}` : ""}{t.assigned_to ? ` · ${M.find((m) => m.id === t.assigned_to)?.name ?? "assigned"}` : ""}</div>
              </Link>
            ))}
          </div>

          <div className="thread card stack" style={{ padding: 18 }}>
            {!selected && <div className="muted">Pick a conversation on the left.</div>}
            {selected && (
              <>
                <div className="row between" style={{ flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
                  <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                    <Link href={href({ t: undefined })} className="small muted" aria-label="Back to the list">← list</Link>
                    <ChannelTag channel={selected.channel} />
                    <h2 style={{ margin: 0 }}>{displayName(selected)}</h2>
                    {selected.counterpart_handle && selected.counterpart_name && <span className="muted small">{selected.channel === "instagram" ? `@${selected.counterpart_handle.replace(/^@/, "")}` : selected.counterpart_handle}</span>}
                    {selected.mailbox && <span className="muted small">→ {selected.mailbox}@</span>}
                  </div>
                  {selected.channel === "instagram" && selected.counterpart_handle && (
                    <a href={`https://instagram.com/${selected.counterpart_handle.replace(/^@/, "")}`} target="_blank" rel="noreferrer" className="small" style={{ fontWeight: 600 }}>Open in Instagram ↗</a>
                  )}
                  {selected.channel === "email" && messages.length > 0 && (
                    <a href={`https://mail.google.com/mail/u/0/#search/${encodeURIComponent(`rfc822msgid:${messages[messages.length - 1].external_id.replace(/^<|>$/g, "")}`)}`} target="_blank" rel="noreferrer" className="small" style={{ fontWeight: 600 }}>Reply in Gmail ↗</a>
                  )}
                </div>
                {selected.subject && <div className="bold">{selected.subject}</div>}

                <form action={setThreadGist} className="row" style={{ gap: 6 }}>
                  <input type="hidden" name="thread_id" value={selected.id} />
                  {Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                  <input name="gist" defaultValue={selected.gist ?? ""} placeholder="One line: what they want / where it stands" className="grow" maxLength={200} />
                  <button className="btn line sm">Save</button>
                </form>

                <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
                  <form action={setThreadStatus} className="row" style={{ gap: 4 }}>
                    <input type="hidden" name="thread_id" value={selected.id} />
                    {Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    <select name="status" defaultValue={selected.status} className="sm" aria-label="Status">{STATUSES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}</select>
                    <button className="btn line sm">Set</button>
                  </form>
                  <form action={setThreadTopic} className="row" style={{ gap: 4 }}>
                    <input type="hidden" name="thread_id" value={selected.id} />
                    {Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    <select name="topic" defaultValue={selected.topic} className="sm" aria-label="Topic">{TOPICS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</select>
                    <button className="btn line sm">Set</button>
                  </form>
                  <form action={assignThread} className="row" style={{ gap: 4 }}>
                    <input type="hidden" name="thread_id" value={selected.id} />
                    {Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    <select name="assigned_to" defaultValue={selected.assigned_to ?? ""} className="sm" aria-label="Assigned to"><option value="">Nobody</option>{inboxPeople.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                    <button className="btn line sm">Assign</button>
                  </form>
                  <form action={linkThreadMember} className="row" style={{ gap: 4 }}>
                    <input type="hidden" name="thread_id" value={selected.id} />
                    {Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    <select name="member_id" defaultValue={selected.member_id ?? ""} className="sm" aria-label="Member"><option value="">Not a member / unknown</option>{M.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                    <button className="btn line sm">Link</button>
                  </form>
                </div>

                {linkedMember && (
                  <div className="notice ok small">
                    Member <b>{linkedMember.name}</b>{linkedMember.email ? ` · ${linkedMember.email}` : ""}{linkedMember.instagram ? ` · @${linkedMember.instagram}` : ""}
                    {bookings.length > 0 ? ` · next seats: ${bookings.map((b) => `${b.date.slice(5)} ${(Array.isArray(b.slot) ? b.slot[0]?.session : b.slot?.session) ?? ""}`).join(", ")}` : " · no upcoming seat"}
                  </div>
                )}

                <div className="msgs">
                  {messages.map((m) => (
                    <div key={m.id} className={`msg ${m.direction}`}>
                      <div className="muted small">{m.direction === "in" ? (m.from_name || m.from_handle || displayName(selected)) : `us${m.is_echo ? " (from the Instagram app)" : ""}`} · {new Date(m.sent_at).toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" }).slice(0, 16)}</div>
                      {m.subject && m.channel === "email" && m.subject !== selected.subject && <div className="bold small">{m.subject}</div>}
                      <div className="prewrap">{m.text ?? <span className="muted">(no text)</span>}</div>
                      {m.attachments.length > 0 && (
                        <div className="row" style={{ flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                          {m.attachments.map((a, i) => a.url
                            ? <a key={i} href={a.url} target="_blank" rel="noreferrer" className="tag">{a.type === "image" ? "image" : a.name ?? a.type} ↗</a>
                            : <span key={i} className="tag" title="Attachment stays in Gmail">{a.name ?? a.type}</span>)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {selected.channel === "instagram" ? (
                  <ReplyBox action={replyInstagram} threadId={selected.id} templates={tmpl.filter((t) => t.channel !== "email")} hidden={filters}
                    disabled={igLeft === null || igLeft <= 0}
                    disabledText={igLeft !== null && igLeft <= 0 ? "More than 24 h since their last message — answer from the Instagram app on the phone." : undefined} />
                ) : (
                  <div className="muted small">Mail is answered in Gmail (button above) for now; the reply will show up here once sent-mail copies are on (v20).</div>
                )}
                {igLeft !== null && igLeft > 0 && <div className="muted small">Instagram reply window: {leftText(igLeft)}.</div>}

                <div className="divider" />
                <div className="stack" style={{ gap: 6 }}>
                  <div className="muted small" style={{ fontWeight: 600 }}>Tasks from this conversation</div>
                  {tasks.map((t) => <div key={t.id} className="small">{t.status === "suggested" ? <span className="tag">suggested</span> : null} {t.title}</div>)}
                  <form action={addTask} className="row" style={{ gap: 6 }}>
                    <input type="hidden" name="from" value="thread" />
                    <input type="hidden" name="thread_id" value={selected.id} />
                    {Object.entries(filters).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
                    <input name="title" placeholder="New task…" className="grow" maxLength={140} required />
                    <select name="owner_id" defaultValue={me.id} className="sm" aria-label="Owner">{inboxPeople.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                    <SubmitButton className="btn line sm" pendingText="…">Add</SubmitButton>
                  </form>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
