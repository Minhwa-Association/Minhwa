import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Resend — the one outside service for e-mail: it receives receipt@in.minhwa.org (the copy Microsoft 365
 * sends on) and posts a webhook; it sends the app's "received" reply from manager@minhwa.org.
 * Plain fetch calls, no SDK, so nothing here goes stale with a package version.
 */

const API = "https://api.resend.com";

function apiKey(): string {
  const k = process.env.RESEND_API_KEY;
  if (!k) throw new Error("RESEND_API_KEY is not set");
  return k;
}

/**
 * Webhook signature check (Svix scheme, as Resend uses): headers svix-id, svix-timestamp, svix-signature;
 * secret "whsec_<base64>"; signed content "<id>.<timestamp>.<raw body>"; HMAC-SHA256, base64; several
 * "v1,<sig>" entries may be present; the timestamp must be within 5 minutes.
 */
export function verifyWebhook(rawBody: string, headers: Headers, secret: string): { ok: true } | { ok: false; reason: string } {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const ts = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const sigHeader = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !ts || !sigHeader) return { ok: false, reason: "signature headers missing" };
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) return { ok: false, reason: "timestamp outside the window" };
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const expected = createHmac("sha256", key).update(`${id}.${ts}.${rawBody}`).digest();
  for (const part of sigHeader.split(/\s+/)) {
    const [version, value] = part.split(",", 2);
    if (version !== "v1" || !value) continue;
    let given: Buffer;
    try { given = Buffer.from(value, "base64"); } catch { continue; }
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature does not match" };
}

export type ReceivedAttachmentMeta = { id: string; filename: string | null; content_type: string | null; content_disposition: string | null; content_id: string | null; size?: number | null };

export type ReceivedEmail = {
  id: string;
  from: string;                     // "Name <a@b>" or "a@b"
  to: string[];
  cc: string[];
  subject: string | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string>;
  message_id: string | null;
  created_at: string;
  attachments: ReceivedAttachmentMeta[];
};

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${apiKey()}` }, cache: "no-store" });
  if (!res.ok) throw new Error(`Resend ${path} → ${res.status} ${await res.text().catch(() => "")}`.trim());
  return (await res.json()) as T;
}

/** The full mail behind an email.received event (the webhook itself carries only metadata). */
export async function fetchReceivedEmail(emailId: string): Promise<ReceivedEmail> {
  return get<ReceivedEmail>(`/emails/receiving/${encodeURIComponent(emailId)}`);
}

/** One attachment's bytes, through the temporary download link Resend gives. */
export async function fetchAttachment(emailId: string, attachmentId: string): Promise<{ meta: ReceivedAttachmentMeta; bytes: Buffer }> {
  const meta = await get<ReceivedAttachmentMeta & { download_url: string }>(`/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`);
  const res = await fetch(meta.download_url, { cache: "no-store" });
  if (!res.ok) throw new Error(`attachment download → ${res.status}`);
  return { meta, bytes: Buffer.from(await res.arrayBuffer()) };
}

/** "Jisu Park <jisu@x.se>" → {name: "Jisu Park", email: "jisu@x.se"} */
export function parseAddress(s: string | null | undefined): { name: string | null; email: string | null } {
  if (!s) return { name: null, email: null };
  const m = s.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() || null };
  const bare = s.trim();
  return { name: null, email: bare.includes("@") ? bare.toLowerCase() : null };
}

/** Send one plain-text mail as the association. Returns the Resend id. */
export async function sendMail(opts: { to: string; subject: string; text: string; replyTo?: string }): Promise<string> {
  const from = process.env.MAIL_FROM;
  if (!from) throw new Error("MAIL_FROM is not set");
  const res = await fetch(`${API}/emails`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: [opts.to], subject: opts.subject, text: opts.text, reply_to: opts.replyTo ?? process.env.MAIL_REPLY_TO ?? undefined }),
  });
  if (!res.ok) throw new Error(`Resend send → ${res.status} ${await res.text().catch(() => "")}`.trim());
  const j = (await res.json()) as { id?: string };
  return j.id ?? "";
}

/** A very small HTML → text for e-receipts that come without a text part */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'")
    .split("\n").map((l) => l.replace(/[ \t]{2,}/g, " ").trim()).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
