import { createServiceClient } from "@/lib/supabase/service";
import { ASSOCIATION, askTool, str } from "@/lib/comms/claude";
import { displayName, type ThreadRow } from "@/lib/comms/types";

/**
 * "What is going on" — a short summary of the conversations that moved since `since`, written by Claude
 * and stored in comms_digests. v19: on request (button on the Overview). v20: every morning by cron.
 * Notifications are counted, not summarised.
 */

export async function writeDigest(opts: { since: Date; createdBy: string | null; lang?: "en" | "ko" | "sv" }): Promise<{ id: string | null; text: string; note: string | null }> {
  const supabase = createServiceClient();
  const sinceISO = opts.since.toISOString();
  const [{ data: threads }, { data: openTasks }] = await Promise.all([
    supabase.from("comms_threads").select("*").gte("last_message_at", sinceISO).order("last_message_at", { ascending: false }).limit(40),
    supabase.from("comms_tasks").select("title, due_on, owner:members!comms_tasks_owner_id_fkey(name)").eq("status", "open").order("due_on").limit(20),
  ]);
  const T = (threads ?? []) as ThreadRow[];
  const active = T.filter((t) => t.topic !== "notice");
  const notices = T.length - active.length;
  const ids = active.map((t) => t.id);
  const { data: messages } = ids.length
    ? await supabase.from("comms_messages").select("thread_id, direction, from_name, text, sent_at").in("thread_id", ids).gte("sent_at", sinceISO).order("sent_at")
    : { data: [] as { thread_id: string; direction: string; from_name: string | null; text: string | null; sent_at: string }[] };

  const stats = {
    threads: active.length,
    instagram: active.filter((t) => t.channel === "instagram").length,
    email: active.filter((t) => t.channel === "email").length,
    notices,
    open: active.filter((t) => t.status === "open").length,
    messages: (messages ?? []).length,
  };

  if (active.length === 0) {
    const text = "Nothing new since the last summary" + (notices ? ` (${notices} automatic notification${notices === 1 ? "" : "s"}).` : ".");
    const { data } = await supabase.from("comms_digests").insert({ for_date: new Date().toISOString().slice(0, 10), since: sinceISO, text, stats, created_by: opts.createdBy }).select("id").single();
    return { id: data?.id ?? null, text, note: null };
  }

  const blocks = active.map((t) => {
    const ms = (messages ?? []).filter((m) => m.thread_id === t.id);
    const lines = ms.map((m) => `  ${m.sent_at.slice(5, 16).replace("T", " ")} ${m.direction === "in" ? (m.from_name || "them") : "us"}: ${(m.text ?? "").replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    return `• [${t.channel}] ${displayName(t)}${t.subject ? ` — "${t.subject}"` : ""} · status ${t.status} · topic ${t.topic}${t.gist ? ` · gist: ${t.gist}` : ""}\n${lines || "  (no new text)"}`;
  }).join("\n\n");
  const ownerName = (o: unknown): string | null => { const v = Array.isArray(o) ? o[0] : o; return (v as { name?: string } | null)?.name ?? null; };
  const tasks = (openTasks ?? []).map((x) => `- ${x.title}${x.due_on ? ` (due ${x.due_on})` : ""}${ownerName(x.owner) ? ` — ${ownerName(x.owner)}` : ""}`).join("\n");

  const lang = opts.lang ?? "en";
  const { input, note } = await askTool<{ summary: string }>({
    system: `You write the morning summary for the manager of ${ASSOCIATION} Plain text, no markdown headings. Write in ${lang === "ko" ? "Korean" : lang === "sv" ? "Swedish" : "English"}. Keep names and quoted phrases in their original language. Never invent anything that is not in the conversations.`,
    user: [
      `Conversations that moved since ${sinceISO.slice(0, 16).replace("T", " ")} (UTC):`, "", blocks, "",
      tasks ? `Open tasks:\n${tasks}` : "No open tasks.", "",
      "Write 'what is going on': one line per conversation that matters (who, what they want, where it stands, who is waiting on whom, how long). Group trivial ones in a line. Then a short 'needs an answer today' list. At most 15 lines.",
    ].join("\n"),
    tool: { name: "write_summary", description: "The summary.", input_schema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] } },
    maxTokens: 900,
  });
  const text = str(input?.summary) ?? `Could not write the summary (${note ?? "no answer"}). ${active.length} conversations moved, ${stats.open} open.`;
  const { data } = await supabase.from("comms_digests").insert({ for_date: new Date().toISOString().slice(0, 10), since: sinceISO, text, stats, created_by: opts.createdBy }).select("id").single();
  return { id: data?.id ?? null, text, note: input ? null : note };
}
