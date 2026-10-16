import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { fetchReceivedEmail } from "@/lib/mail/resend";
import { finishClaim, ingestInboundEmail } from "@/lib/claims-process";
import { isReceiptMail, mailboxOf, referencedIds, toInbound } from "@/lib/comms/mail";
import { fetchProfile, parseWebhook, type IgWebhook } from "@/lib/comms/instagram";
import { classifyThread } from "@/lib/comms/classify";
import type { InboundMessage, UpsertResult } from "@/lib/comms/types";

/** Store one message (service role) — the DB links the member and keeps the thread's counters. */
export async function storeInbound(msg: InboundMessage): Promise<UpsertResult> {
  const supabase = createServiceClient();
  const { data, error } = await supabase.rpc("comms_upsert_inbound", { p: msg });
  if (error) throw new Error(`comms_upsert_inbound: ${error.message}`);
  return data as UpsertResult;
}

/** Sorting runs behind the response; a failure only logs. */
function classifyLater(threadId: string, why: string) {
  after(async () => {
    try { await classifyThread(threadId); }
    catch (e) { console.error("classifyThread", why, e instanceof Error ? e.message : e); }
  });
}

/* ───────── e-mail (Resend email.received) ───────── */

export type MailResult = { kind: "receipt" | "inbox" | "ignored"; threadId?: string; created?: boolean; claimId?: string; reason?: string };

/** One Resend event → Kvitton (receipt@) or the Inbox (manager@). */
export async function handleReceivedMail(emailId: string): Promise<MailResult> {
  const mail = await fetchReceivedEmail(emailId);

  if (isReceiptMail(mail)) {
    const result = await ingestInboundEmail(emailId);
    if (result.created) {
      after(async () => {
        try { await finishClaim(result.claimId, { sendAck: true }); }
        catch (e) { console.error("finishClaim", result.code, e instanceof Error ? e.message : e); }
      });
    }
    return { kind: "receipt", claimId: result.claimId, created: result.created };
  }

  const mailbox = mailboxOf(mail);
  if (!mailbox) return { kind: "ignored", reason: "not for an inbox mailbox" };

  // an answer in a known conversation → the same thread (by In-Reply-To / References)
  let knownKey: string | null = null;
  const refs = referencedIds(mail);
  if (refs.length) {
    const supabase = createServiceClient();
    const { data } = await supabase.from("comms_messages").select("thread:comms_threads!comms_messages_thread_id_fkey(external_id)").in("external_id", refs).limit(1).maybeSingle();
    const t = (data as { thread?: { external_id?: string } | { external_id?: string }[] } | null)?.thread;
    const ext = Array.isArray(t) ? t[0]?.external_id : t?.external_id;
    if (ext) knownKey = ext;
  }

  const msg = toInbound(mail, mailbox, knownKey);
  const r = await storeInbound(msg);
  if (r.created && msg.message.direction === "in") classifyLater(r.thread_id, `mail ${emailId}`);
  return { kind: "inbox", threadId: r.thread_id, created: r.created };
}

/* ───────── Instagram (Meta webhook) ───────── */

export async function handleInstagramWebhook(body: IgWebhook): Promise<{ stored: number; skipped: number }> {
  const ownId = process.env.IG_USER_ID ?? "";
  const items = parseWebhook(body, ownId);
  let stored = 0, skipped = 0;
  const supabase = createServiceClient();
  for (const { counterpartId, message } of items) {
    // name and picture once per counterpart (the thread keeps them)
    const { data: existing } = await supabase.from("comms_threads").select("id, counterpart_handle").eq("channel", "instagram").eq("external_id", counterpartId).maybeSingle();
    if (!existing?.counterpart_handle) {
      const p = await fetchProfile(counterpartId);
      if (p) { message.counterpart_name = p.name; message.counterpart_handle = p.username; message.profile_pic = p.profile_pic; }
    }
    const r = await storeInbound(message);
    if (r.created) {
      stored++;
      if (message.message.direction === "in") classifyLater(r.thread_id, `ig ${message.message.external_id}`);
    } else skipped++;
  }
  return { stored, skipped };
}
