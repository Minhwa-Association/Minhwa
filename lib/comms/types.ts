/** Inbox (v19) — shared shapes for threads, messages and tasks. */

export type Channel = "instagram" | "email";
export type ThreadStatus = "open" | "waiting" | "done";
export type Topic = "unsorted" | "booking" | "class" | "material" | "partner" | "admin" | "notice" | "other";
export type TaskStatus = "suggested" | "open" | "done" | "dropped";

export const TOPICS: { key: Topic; label: string; hint: string }[] = [
  { key: "booking", label: "Booking", hint: "seats, waiting list, passes" },
  { key: "class", label: "Class", hint: "what we teach, when, how to start" },
  { key: "material", label: "Material / Shop", hint: "brushes, paper, paint, orders" },
  { key: "partner", label: "Partner / event", hint: "schools, fairs, other associations, press" },
  { key: "admin", label: "Admin / invoice", hint: "invoices, bank, authorities, suppliers" },
  { key: "notice", label: "Notification", hint: "automatic mail from services — folded away" },
  { key: "other", label: "Other", hint: "" },
  { key: "unsorted", label: "Unsorted", hint: "" },
];

export const STATUSES: { key: ThreadStatus; label: string; hint: string }[] = [
  { key: "open", label: "Open", hint: "they wrote last — needs an answer or a decision" },
  { key: "waiting", label: "Waiting", hint: "we answered — waiting for them" },
  { key: "done", label: "Done", hint: "" },
];

export type Attachment = { type: string; url: string | null; name: string | null };

export type ThreadRow = {
  id: string;
  channel: Channel;
  mailbox: string | null;
  external_id: string;
  counterpart_name: string | null;
  counterpart_handle: string | null;
  profile_pic: string | null;
  member_id: string | null;
  subject: string | null;
  topic: Topic;
  gist: string | null;
  status: ThreadStatus;
  assigned_to: string | null;
  last_in_at: string | null;
  last_out_at: string | null;
  last_message_at: string | null;
  last_preview: string | null;
  unread: number;
  created_at: string;
};

export type MessageRow = {
  id: string;
  thread_id: string;
  channel: Channel;
  external_id: string;
  direction: "in" | "out";
  from_name: string | null;
  from_handle: string | null;
  to_handle: string | null;
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: Attachment[];
  is_echo: boolean;
  sent_by: string | null;
  sent_at: string;
};

export type TaskRow = {
  id: string;
  title: string;
  detail: string | null;
  owner_id: string | null;
  due_on: string | null;
  status: TaskStatus;
  source_thread_id: string | null;
  created_by: string | null;
  created_at: string;
  done_at: string | null;
};

export type TemplateRow = { id: string; title: string; body: string; lang: "sv" | "en" | "ko"; channel: "any" | Channel; sort: number };

/** What the webhooks hand to comms_upsert_inbound. */
export type InboundMessage = {
  channel: Channel;
  external_thread_id: string;
  mailbox: string | null;
  counterpart_name: string | null;
  counterpart_handle: string | null;
  profile_pic?: string | null;
  subject?: string | null;
  message: {
    external_id: string;
    direction: "in" | "out";
    from_name: string | null;
    from_handle: string | null;
    to_handle: string | null;
    subject?: string | null;
    text: string | null;
    html?: string | null;
    attachments: Attachment[];
    is_echo?: boolean;
    sent_by?: string | null;
    sent_at: string;
    raw?: unknown;
  };
};

export type UpsertResult = { thread_id: string; message_id: string; created: boolean };

/** Instagram lets us answer a DM for 24 hours after their last message. */
export const IG_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

export function igWindowLeftMs(lastInAt: string | null | undefined, now = Date.now()): number {
  if (!lastInAt) return 0;
  return Math.max(0, new Date(lastInAt).getTime() + IG_REPLY_WINDOW_MS - now);
}

export function displayName(t: Pick<ThreadRow, "counterpart_name" | "counterpart_handle" | "channel">): string {
  if (t.counterpart_name) return t.counterpart_name;
  if (t.counterpart_handle) return t.channel === "instagram" ? `@${t.counterpart_handle.replace(/^@/, "")}` : t.counterpart_handle;
  return t.channel === "instagram" ? "Instagram user" : "Unknown sender";
}

/** "2 h ago" · "3 d ago" · "just now" — for lists. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} d ago`;
}

/** "1 h 20 min left" for the Instagram window. */
export function leftText(ms: number): string {
  if (ms <= 0) return "window closed";
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h} h ${m % 60} min left` : `${m} min left`;
}
