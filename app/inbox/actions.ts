"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseInbox, hasRole } from "@/lib/roles";
import { sendText } from "@/lib/comms/instagram";
import { storeInbound } from "@/lib/comms/ingest";
import { writeDigest } from "@/lib/comms/digest";
import { igWindowLeftMs, STATUSES, TOPICS } from "@/lib/comms/types";

/** Inbox (v19) — what a person can do on the Inbox pages. Every action: logged in + inbox access. */

async function inboxUser() {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseInbox(me)) redirect("/");
  return me;
}

function go(path: string, q: Record<string, string | null | undefined>): never {
  const qs = Object.entries(q).filter(([, v]) => v).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  redirect(qs ? `${path}?${qs}` : path);
}

function refresh() {
  for (const p of ["/inbox", "/inbox/messages", "/inbox/tasks", "/inbox/settings"]) revalidatePath(p);
}

const s = (fd: FormData, k: string) => String(fd.get(k) ?? "").trim();
const uuidOrNull = (v: string) => (/^[0-9a-f-]{36}$/i.test(v) ? v : null);

/** Keep the list's filters when coming back to the thread. */
function threadBack(fd: FormData, extra: Record<string, string | null>): never {
  go("/inbox/messages", { t: s(fd, "thread_id"), channel: s(fd, "channel") || null, status: s(fd, "status_filter") || null, topic: s(fd, "topic_filter") || null, ...extra });
}

/* ───────── thread ───────── */

export async function replyInstagram(fd: FormData) {
  const me = await inboxUser();
  const threadId = s(fd, "thread_id");
  const text = s(fd, "text").slice(0, 1000);
  if (!text) threadBack(fd, { error: "Write something first." });
  const supabase = await createClient();
  const { data: t } = await supabase.from("comms_threads").select("id, channel, external_id, last_in_at").eq("id", threadId).single();
  if (!t || t.channel !== "instagram") threadBack(fd, { error: "Not an Instagram conversation." });
  if (igWindowLeftMs(t.last_in_at) <= 0) threadBack(fd, { error: "More than 24 hours since their last message — Instagram only lets us answer from the Instagram app now." });
  let mid: string;
  try { mid = await sendText(t.external_id, text); }
  catch (e) { threadBack(fd, { error: e instanceof Error ? e.message : "Could not send." }); }
  await storeInbound({
    channel: "instagram", external_thread_id: t.external_id, mailbox: null, counterpart_name: null, counterpart_handle: null,
    message: { external_id: mid, direction: "out", from_name: me.name, from_handle: "instagram", to_handle: t.external_id, text, attachments: [], sent_by: me.id, sent_at: new Date().toISOString() },
  });
  refresh();
  threadBack(fd, { ok: "sent" });
}

export async function setThreadStatus(fd: FormData) {
  await inboxUser();
  const status = s(fd, "status");
  if (!STATUSES.some((x) => x.key === status)) threadBack(fd, { error: "Unknown status." });
  const supabase = await createClient();
  const { error } = await supabase.from("comms_threads").update({ status }).eq("id", s(fd, "thread_id"));
  if (error) threadBack(fd, { error: error.message });
  refresh();
  threadBack(fd, { ok: status === "done" ? "done" : "saved" });
}

export async function setThreadTopic(fd: FormData) {
  await inboxUser();
  const topic = s(fd, "topic");
  if (!TOPICS.some((x) => x.key === topic)) threadBack(fd, { error: "Unknown topic." });
  const supabase = await createClient();
  const { error } = await supabase.from("comms_threads").update({ topic }).eq("id", s(fd, "thread_id"));
  if (error) threadBack(fd, { error: error.message });
  refresh();
  threadBack(fd, { ok: "saved" });
}

export async function setThreadGist(fd: FormData) {
  await inboxUser();
  const supabase = await createClient();
  const { error } = await supabase.from("comms_threads").update({ gist: s(fd, "gist").slice(0, 200) || null }).eq("id", s(fd, "thread_id"));
  if (error) threadBack(fd, { error: error.message });
  refresh();
  threadBack(fd, { ok: "saved" });
}

export async function assignThread(fd: FormData) {
  await inboxUser();
  const supabase = await createClient();
  const { error } = await supabase.from("comms_threads").update({ assigned_to: uuidOrNull(s(fd, "assigned_to")) }).eq("id", s(fd, "thread_id"));
  if (error) threadBack(fd, { error: error.message });
  refresh();
  threadBack(fd, { ok: "saved" });
}

export async function linkThreadMember(fd: FormData) {
  await inboxUser();
  const supabase = await createClient();
  const { error } = await supabase.from("comms_threads").update({ member_id: uuidOrNull(s(fd, "member_id")) }).eq("id", s(fd, "thread_id"));
  if (error) threadBack(fd, { error: error.message });
  refresh();
  threadBack(fd, { ok: "saved" });
}

/* ───────── tasks ───────── */

export async function addTask(fd: FormData) {
  const me = await inboxUser();
  const title = s(fd, "title").slice(0, 140);
  const from = s(fd, "from") || "tasks";
  const fail = (msg: string): never => (from === "thread" ? threadBack(fd, { error: msg }) : go("/inbox/tasks", { error: msg }));
  if (!title) fail("A task needs a title.");
  const due = s(fd, "due_on");
  const supabase = await createClient();
  const { error } = await supabase.from("comms_tasks").insert({
    title, detail: s(fd, "detail").slice(0, 600) || null, owner_id: uuidOrNull(s(fd, "owner_id")) ?? me.id,
    due_on: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null, status: "open", source_thread_id: uuidOrNull(s(fd, "thread_id")), created_by: me.id,
  });
  if (error) fail(error.message);
  refresh();
  if (from === "thread") threadBack(fd, { ok: "task" });
  go("/inbox/tasks", { ok: "task" });
}

export async function setTaskStatus(fd: FormData) {
  await inboxUser();
  const supabase = await createClient();
  const { error } = await supabase.rpc("comms_task_set_status", { p_task: s(fd, "task_id"), p_status: s(fd, "status") });
  if (error) go("/inbox/tasks", { error: error.message });
  refresh();
  go("/inbox/tasks", { ok: s(fd, "status") });
}

export async function updateTask(fd: FormData) {
  await inboxUser();
  const due = s(fd, "due_on");
  const supabase = await createClient();
  const { error } = await supabase.from("comms_tasks").update({ owner_id: uuidOrNull(s(fd, "owner_id")), due_on: /^\d{4}-\d{2}-\d{2}$/.test(due) ? due : null, title: s(fd, "title").slice(0, 140) || undefined }).eq("id", s(fd, "task_id"));
  if (error) go("/inbox/tasks", { error: error.message });
  refresh();
  go("/inbox/tasks", { ok: "saved" });
}

/* ───────── summary ───────── */

export async function summariseNow(fd: FormData) {
  const me = await inboxUser();
  const supabase = await createClient();
  const { data: last } = await supabase.from("comms_digests").select("created_at").order("created_at", { ascending: false }).limit(1).maybeSingle();
  const fallback = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const since = last?.created_at ? new Date(Math.max(new Date(last.created_at).getTime(), Date.now() - 14 * 24 * 60 * 60 * 1000)) : fallback;
  const lang = (["en", "ko", "sv"] as const).find((l) => l === s(fd, "lang")) ?? "en";
  try { await writeDigest({ since, createdBy: me.id, lang }); }
  catch (e) { go("/inbox", { error: e instanceof Error ? e.message : "Could not write the summary." }); }
  refresh();
  go("/inbox", { ok: "digest" });
}

/* ───────── settings (templates · domains · retention · token date) ───────── */

export async function saveTemplate(fd: FormData) {
  await inboxUser();
  const id = uuidOrNull(s(fd, "template_id"));
  const row = { title: s(fd, "title").slice(0, 80), body: s(fd, "body").slice(0, 2000), lang: s(fd, "lang") || "sv", channel: s(fd, "channel") || "any", sort: Number(s(fd, "sort")) || 100 };
  if (!row.title || !row.body) go("/inbox/settings", { error: "A quick reply needs a title and a text." });
  const supabase = await createClient();
  const { error } = id ? await supabase.from("comms_templates").update(row).eq("id", id) : await supabase.from("comms_templates").insert(row);
  if (error) go("/inbox/settings", { error: error.message });
  refresh();
  go("/inbox/settings", { ok: "saved" });
}

export async function deleteTemplate(fd: FormData) {
  await inboxUser();
  const supabase = await createClient();
  const { error } = await supabase.from("comms_templates").delete().eq("id", s(fd, "template_id"));
  if (error) go("/inbox/settings", { error: error.message });
  refresh();
  go("/inbox/settings", { ok: "removed" });
}

/** Notification domains, retention, Instagram token date — Admin or Manager. */
export async function saveInboxSettings(fd: FormData) {
  const me = await inboxUser();
  if (!hasRole(me, "admin") && !hasRole(me, "manager")) go("/inbox/settings", { error: "Admin or Manager only." });
  const domains = s(fd, "notify_domains").split(/[\s,;]+/).map((d) => d.toLowerCase().replace(/^@/, "")).filter((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d));
  const months = Math.min(60, Math.max(1, Number(s(fd, "inbox_retention_months")) || 12));
  const exp = s(fd, "ig_token_expires_at");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_inbox_settings", { p_domains: domains, p_months: months, p_expires: /^\d{4}-\d{2}-\d{2}$/.test(exp) ? exp : null });
  if (error) go("/inbox/settings", { error: error.message });
  refresh();
  go("/inbox/settings", { ok: "settings" });
}
