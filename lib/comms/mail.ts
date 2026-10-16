import { createHash } from "node:crypto";
import { htmlToText, parseAddress, type ReceivedEmail } from "@/lib/mail/resend";
import type { InboundMessage } from "@/lib/comms/types";

/**
 * Association mail → Inbox. Google Workspace copies every mail for manager@minhwa.org to
 * manager@in.minhwa.org; Resend receives in.minhwa.org and posts the webhook that /api/inbound/mail
 * (and /api/inbound/receipt — same handler) answers. Receipts (receipt@) keep going to Kvitton; everything
 * else lands here. Our own outgoing mail, when a copy reaches us, is filed as direction "out".
 */

const DOMAIN = (process.env.MAIL_DOMAIN || "minhwa.org").toLowerCase();
const INBOUND_DOMAIN = (process.env.MAIL_INBOUND_DOMAIN || `in.${DOMAIN}`).toLowerCase();
const RECEIPT_LOCAL = (process.env.RECEIPT_LOCAL_PART || "receipt").toLowerCase();
/** Mailboxes the inbox knows. 1st release: manager only (decision 1). */
const MAILBOXES = (process.env.INBOX_MAILBOXES || "manager").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);

function localPart(addr: string | null): string | null {
  if (!addr) return null;
  const [local, domain] = addr.toLowerCase().split("@");
  if (!local || !domain) return null;
  if (domain !== DOMAIN && domain !== INBOUND_DOMAIN) return null;
  return local;
}

/** Every address the mail was delivered to or addressed to, lower-case. */
export function recipientAddresses(mail: ReceivedEmail): string[] {
  const out = new Set<string>();
  for (const raw of [...(mail.to ?? []), ...(mail.cc ?? [])]) {
    const e = parseAddress(raw).email;
    if (e) out.add(e);
  }
  const h = mail.headers ?? {};
  for (const key of Object.keys(h)) {
    const k = key.toLowerCase();
    if (k === "delivered-to" || k === "x-original-to" || k === "x-forwarded-to" || k === "x-envelope-to" || k === "to" || k === "cc") {
      for (const part of String(h[key]).split(",")) {
        const e = parseAddress(part).email;
        if (e) out.add(e);
      }
    }
  }
  return [...out];
}

/** True when this mail is for the receipt address — it belongs to Kvitton, not the Inbox. */
export function isReceiptMail(mail: ReceivedEmail): boolean {
  return recipientAddresses(mail).some((a) => localPart(a) === RECEIPT_LOCAL);
}

/** Which inbox mailbox the mail belongs to; null when it is for none of them. */
export function mailboxOf(mail: ReceivedEmail): string | null {
  const locals = recipientAddresses(mail).map(localPart).filter((l): l is string => !!l);
  return MAILBOXES.find((m) => locals.includes(m)) ?? null;
}

function isOwnAddress(addr: string | null): boolean {
  return !!addr && localPart(addr) !== null;
}

/** The sender's domain — "fortnox.se" — for the notification list. */
export function senderDomain(addr: string | null): string | null {
  const d = addr?.toLowerCase().split("@")[1];
  return d || null;
}

function normSubject(s: string | null): string {
  return (s ?? "").replace(/^\s*((re|sv|fwd?|vb|fw|aw|답장|회신|전달)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function firstId(v: string | undefined): string | null {
  if (!v) return null;
  const m = v.match(/<[^>]+>/);
  return (m ? m[0] : v.trim()) || null;
}

/** Build the message for comms_upsert_inbound. `threadKeyOf` lets the caller look up an existing thread by References. */
export function toInbound(mail: ReceivedEmail, mailbox: string, knownThreadKey: string | null): InboundMessage {
  const h = mail.headers ?? {};
  const header = (k: string) => h[k] ?? h[k.toLowerCase()] ?? h[k.charAt(0).toUpperCase() + k.slice(1)];
  const from = parseAddress(header("from") ?? mail.from);
  const own = isOwnAddress(from.email);
  const external = recipientAddresses(mail).filter((a) => !isOwnAddress(a));
  const counterpartEmail = own ? (external[0] ?? null) : from.email;
  const counterpartName = own ? null : from.name;

  const messageId = mail.message_id?.trim() || firstId(header("message-id")) || `resend:${mail.id}`;
  const subjectKey = normSubject(mail.subject);
  const threadKey = knownThreadKey ?? `${counterpartEmail ?? "unknown"}|${subjectKey || createHash("sha1").update(messageId).digest("hex").slice(0, 10)}`;

  const text = (mail.text?.trim() || (mail.html ? htmlToText(mail.html) : "")).slice(0, 20000) || null;
  const attachments = (mail.attachments ?? []).filter((a) => a.content_disposition !== "inline" || !a.content_id).map((a) => ({ type: a.content_type ?? "file", url: null, name: a.filename }));

  return {
    channel: "email",
    external_thread_id: threadKey,
    mailbox,
    counterpart_name: counterpartName,
    counterpart_handle: counterpartEmail,
    subject: mail.subject ?? null,
    message: {
      external_id: messageId,
      direction: own ? "out" : "in",
      from_name: from.name,
      from_handle: from.email,
      to_handle: external[0] ?? mail.to?.[0] ?? null,
      subject: mail.subject ?? null,
      text,
      html: mail.html ? mail.html.slice(0, 200000) : null,
      attachments,
      sent_at: mail.created_at,
      raw: { id: mail.id, message_id: messageId, in_reply_to: firstId(header("in-reply-to")), references: header("references") ?? null },
    },
  };
}

/** Message-IDs this mail answers (In-Reply-To + References), to find the thread it belongs to. */
export function referencedIds(mail: ReceivedEmail): string[] {
  const h = mail.headers ?? {};
  const get = (k: string) => h[k] ?? h[k.toLowerCase()] ?? h[k.split("-").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join("-")];
  const ids = new Set<string>();
  for (const v of [get("in-reply-to"), get("references")]) {
    if (!v) continue;
    for (const m of String(v).match(/<[^>]+>/g) ?? []) ids.add(m);
  }
  return [...ids];
}
