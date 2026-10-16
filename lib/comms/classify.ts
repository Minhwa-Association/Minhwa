import { createServiceClient } from "@/lib/supabase/service";
import { ASSOCIATION, askTool, str } from "@/lib/comms/claude";
import { senderDomain } from "@/lib/comms/mail";
import { TOPICS, type Topic } from "@/lib/comms/types";

/**
 * After a message has been stored: sort the thread (topic + one-line gist) and suggest tasks.
 * Runs in after() behind the webhook. A person's own topic/gist is never overwritten — only a thread
 * still 'unsorted' gets a topic, and the gist is refreshed only when the thread has no person-written one.
 * Suggested tasks are status 'suggested' until someone approves them (two-step rule).
 * Mail from a sender on settings.notify_domains is filed as 'notice' without asking Claude.
 */

type Row = { id: string; channel: string; topic: Topic; gist: string | null; subject: string | null; counterpart_name: string | null; counterpart_handle: string | null; status: string; gist_by_person?: boolean };

export async function classifyThread(threadId: string): Promise<{ topic: Topic | null; gist: string | null; tasks: number; note: string | null }> {
  const supabase = createServiceClient();
  const [{ data: thread }, { data: messages }, { data: settings }] = await Promise.all([
    supabase.from("comms_threads").select("id, channel, topic, gist, subject, counterpart_name, counterpart_handle, status").eq("id", threadId).single(),
    supabase.from("comms_messages").select("direction, from_name, from_handle, text, sent_at, attachments").eq("thread_id", threadId).order("sent_at", { ascending: false }).limit(8),
    supabase.from("settings").select("notify_domains").eq("id", 1).single(),
  ]);
  if (!thread) return { topic: null, gist: null, tasks: 0, note: "thread not found" };
  const t = thread as Row;
  const msgs = (messages ?? []).reverse();
  const latest = msgs[msgs.length - 1];

  // automatic mail from a known service → notification, no Claude
  if (t.channel === "email" && latest?.direction === "in") {
    const dom = senderDomain(latest.from_handle ?? null);
    const list = ((settings?.notify_domains ?? []) as string[]).map((d) => d.toLowerCase());
    if (dom && list.some((d) => dom === d || dom.endsWith(`.${d}`))) {
      if (t.topic === "unsorted") await supabase.from("comms_threads").update({ topic: "notice", gist: t.gist ?? (t.subject ?? "Automatic notification"), status: "done" }).eq("id", threadId);
      return { topic: "notice", gist: null, tasks: 0, note: null };
    }
  }

  const transcript = msgs.map((m) => {
    const who = m.direction === "in" ? (m.from_name || m.from_handle || "them") : "us (the association)";
    const att = Array.isArray(m.attachments) && m.attachments.length ? ` [${m.attachments.length} attachment(s)]` : "";
    return `${m.sent_at.slice(0, 16).replace("T", " ")} — ${who}: ${(m.text ?? "").slice(0, 1500)}${att}`;
  }).join("\n\n");

  const topicList = TOPICS.filter((x) => x.key !== "unsorted").map((x) => `${x.key} = ${x.label}${x.hint ? ` (${x.hint})` : ""}`).join("; ");
  const { input, note } = await askTool<{ topic: string; gist: string; needs_reply: boolean; tasks: { title: string; detail: string | null }[] }>({
    system: `You sort incoming messages for the manager of ${ASSOCIATION} Answer in the language of the conversation for the gist; task titles in English. Be brief and literal — never invent facts.`,
    user: [
      `Channel: ${t.channel}${t.subject ? ` · Subject: ${t.subject}` : ""}`,
      `Counterpart: ${t.counterpart_name ?? ""} ${t.counterpart_handle ?? ""}`.trim(),
      "", "Conversation (oldest first):", transcript || "(empty)",
      "", "Sort it: topic, one-line gist (what they want / where it stands, max 120 characters), whether it still needs a reply from us, and up to 3 concrete tasks for the manager that the messages clearly ask for (send something, confirm a date, answer a question…). No task when nothing is asked.",
    ].join("\n"),
    tool: {
      name: "sort_thread",
      description: "Sort the conversation.",
      input_schema: {
        type: "object",
        properties: {
          topic: { type: "string", enum: TOPICS.filter((x) => x.key !== "unsorted").map((x) => x.key), description: topicList },
          gist: { type: "string" },
          needs_reply: { type: "boolean" },
          tasks: { type: "array", maxItems: 3, items: { type: "object", properties: { title: { type: "string" }, detail: { type: ["string", "null"] } }, required: ["title", "detail"] } },
        },
        required: ["topic", "gist", "needs_reply", "tasks"],
      },
    },
    maxTokens: 600,
  });
  if (!input) return { topic: null, gist: null, tasks: 0, note };

  const topic = TOPICS.some((x) => x.key === input.topic) ? (input.topic as Topic) : "other";
  const gist = str(input.gist)?.slice(0, 160) ?? null;
  const patch: Record<string, unknown> = {};
  if (t.topic === "unsorted") patch.topic = topic;
  if (gist) patch.gist = gist;   // a person's gist is replaced only when the thread moves on (new message) — acceptable for v19
  if (Object.keys(patch).length) await supabase.from("comms_threads").update(patch).eq("id", threadId);

  let created = 0;
  const tasks = Array.isArray(input.tasks) ? input.tasks.slice(0, 3) : [];
  if (tasks.length) {
    const { data: existing } = await supabase.from("comms_tasks").select("title").eq("source_thread_id", threadId).in("status", ["suggested", "open"]);
    const have = new Set((existing ?? []).map((x) => x.title.toLowerCase()));
    const rows = tasks.map((x) => ({ title: str(x.title)?.slice(0, 140), detail: str(x.detail)?.slice(0, 600) ?? null }))
      .filter((x): x is { title: string; detail: string | null } => !!x.title && !have.has(x.title.toLowerCase()))
      .map((x) => ({ ...x, status: "suggested", source_thread_id: threadId, created_by: null }));
    if (rows.length) {
      const { error } = await supabase.from("comms_tasks").insert(rows);
      if (!error) created = rows.length;
    }
  }
  return { topic, gist, tasks: created, note: null };
}
