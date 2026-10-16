import { createHmac, timingSafeEqual } from "node:crypto";
import type { Attachment, InboundMessage } from "@/lib/comms/types";

/**
 * Instagram — the association's account, through Meta's "Instagram API with Instagram Login".
 * Meta posts every DM to /api/inbound/instagram (webhook field "messages"); replies go back through
 * graph.instagram.com. Plain fetch, no SDK. Env: IG_APP_SECRET (signature) · IG_VERIFY_TOKEN (webhook
 * handshake) · IG_ACCESS_TOKEN (long-lived, 60 days) · IG_USER_ID (the account's id).
 */

const VERSION = process.env.IG_GRAPH_VERSION || "v21.0";
const API = `https://graph.instagram.com/${VERSION}`;

export function igConfigured(): boolean {
  return !!(process.env.IG_ACCESS_TOKEN && process.env.IG_USER_ID);
}

/** X-Hub-Signature-256: "sha256=<hmac-sha256(app secret, raw body)>" */
export function verifySignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const given = header.slice("sha256=".length).trim();
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, "hex"), Buffer.from(expected, "hex"));
}

/* ───────── webhook payload ───────── */

type IgAttachment = { type?: string; payload?: { url?: string; title?: string } };
type IgMessaging = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    attachments?: IgAttachment[];
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    reply_to?: { mid?: string; story?: { url?: string; id?: string } };
  };
  read?: { mid?: string };
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string };
};
export type IgWebhook = { object?: string; entry?: { id?: string; time?: number; messaging?: IgMessaging[] }[] };

export type IgProfile = { name: string | null; username: string | null; profile_pic: string | null };

/** Turn one webhook body into messages for comms_upsert_inbound. Reads, reactions and deletions are skipped. */
export function parseWebhook(body: IgWebhook, ownId: string): { counterpartId: string; message: InboundMessage }[] {
  const out: { counterpartId: string; message: InboundMessage }[] = [];
  if (body.object !== "instagram") return out;
  for (const entry of body.entry ?? []) {
    for (const ev of entry.messaging ?? []) {
      const m = ev.message;
      if (!m?.mid || m.is_deleted) continue;
      const echo = !!m.is_echo || ev.sender?.id === ownId;
      const counterpartId = echo ? ev.recipient?.id : ev.sender?.id;
      if (!counterpartId) continue;
      const attachments: Attachment[] = (m.attachments ?? []).map((a) => ({ type: a.type ?? "file", url: a.payload?.url ?? null, name: a.payload?.title ?? null }));
      if (m.reply_to?.story?.url) attachments.unshift({ type: "story_reply", url: m.reply_to.story.url, name: "Reply to a story" });
      const text = m.text?.trim() || (m.is_unsupported ? "(message type not supported)" : null);
      const sentAt = new Date(ev.timestamp ?? Date.now()).toISOString();
      out.push({
        counterpartId,
        message: {
          channel: "instagram",
          external_thread_id: counterpartId,
          mailbox: null,
          counterpart_name: null,
          counterpart_handle: null,
          message: {
            external_id: m.mid,
            direction: echo ? "out" : "in",
            from_name: null,
            from_handle: echo ? "instagram" : null,
            to_handle: echo ? null : "instagram",
            text,
            attachments,
            is_echo: echo,
            sent_at: sentAt,
            raw: ev,
          },
        },
      });
    }
  }
  return out;
}

/* ───────── Graph calls ───────── */

function token(): string {
  const t = process.env.IG_ACCESS_TOKEN;
  if (!t) throw new Error("IG_ACCESS_TOKEN is not set");
  return t;
}

/** Name, @username and picture of an Instagram-scoped user id. Null when Meta will not tell us. */
export async function fetchProfile(igsid: string): Promise<IgProfile | null> {
  try {
    const res = await fetch(`${API}/${encodeURIComponent(igsid)}?fields=name,username,profile_pic&access_token=${encodeURIComponent(token())}`, { cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as { name?: string; username?: string; profile_pic?: string };
    return { name: j.name ?? null, username: j.username ?? null, profile_pic: j.profile_pic ?? null };
  } catch {
    return null;
  }
}

/** Send one text DM. Returns Meta's message id (becomes the message's external_id). */
export async function sendText(igsid: string, text: string): Promise<string> {
  const userId = process.env.IG_USER_ID;
  if (!userId) throw new Error("IG_USER_ID is not set");
  const res = await fetch(`${API}/${encodeURIComponent(userId)}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient: { id: igsid }, message: { text } }),
  });
  const body = (await res.json().catch(() => ({}))) as { message_id?: string; error?: { message?: string; code?: number } };
  if (!res.ok) throw new Error(body.error?.message ? `Instagram: ${body.error.message}` : `Instagram send → ${res.status}`);
  return body.message_id ?? `sent:${Date.now()}`;
}

/** Long-lived tokens last 60 days; refreshing before they expire gives a fresh 60. (Used by the cron in v20.) */
export async function refreshToken(): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(token())}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Instagram refresh → ${res.status} ${await res.text().catch(() => "")}`.trim());
  return (await res.json()) as { access_token: string; expires_in: number };
}
