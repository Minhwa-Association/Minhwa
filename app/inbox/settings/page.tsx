import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseInbox, hasRole } from "@/lib/roles";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { igConfigured } from "@/lib/comms/instagram";
import type { TemplateRow } from "@/lib/comms/types";
import { InboxNav } from "../InboxNav";
import { deleteTemplate, saveInboxSettings, saveTemplate } from "../actions";

type Q = { error?: string; ok?: string };

function okText(q: Q): string | undefined {
  switch (q.ok) {
    case "saved": return "Saved.";
    case "removed": return "Removed.";
    case "settings": return "Settings saved.";
    default: return undefined;
  }
}

/** Inbox → Settings: quick replies, notification senders, how long we keep conversations, the Instagram token date. (v19) */
export default async function InboxSettingsPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseInbox(me)) redirect("/");
  const q = await searchParams;
  const supabase = await createClient();
  const [{ data: settings }, { data: templates }, { count: unread }, { count: suggested }] = await Promise.all([
    supabase.from("settings").select("notify_domains, inbox_retention_months, ig_token_expires_at").eq("id", 1).single(),
    supabase.from("comms_templates").select("*").order("sort").order("title"),
    supabase.from("comms_threads").select("id", { count: "exact", head: true }).gt("unread", 0),
    supabase.from("comms_tasks").select("id", { count: "exact", head: true }).eq("status", "suggested"),
  ]);
  const T = (templates ?? []) as TemplateRow[];
  const canEdit = hasRole(me, "admin") || hasRole(me, "manager");
  const exp = settings?.ig_token_expires_at as string | null | undefined;
  const daysLeft = exp ? Math.round((new Date(exp).getTime() - Date.now()) / 86400000) : null;
  const appUrl = (process.env.APP_URL ?? "https://app.minhwa.org").replace(/\/$/, "");

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Inbox · Settings</h1><div className="muted small">Quick replies for everyone with inbox access; the rest for Admin and Manager.</div></div>
        <TopNav current="inbox" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <InboxNav current="settings" counts={{ unread: unread ?? 0, suggested: suggested ?? 0 }} />
        <Notice error={q.error} ok={q.ok} text={okText(q)} />

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Quick replies</h2>
          <div className="muted small">Shown as buttons under the reply box; a tap puts the text in, you can still edit before sending.</div>
          {T.map((t) => (
            <form key={t.id} action={saveTemplate} className="tmplrow">
              <input type="hidden" name="template_id" value={t.id} />
              <input name="title" defaultValue={t.title} maxLength={80} aria-label="Title" />
              <select name="lang" defaultValue={t.lang} className="sm" aria-label="Language"><option value="sv">sv</option><option value="en">en</option><option value="ko">ko</option></select>
              <select name="channel" defaultValue={t.channel} className="sm" aria-label="Channel"><option value="any">any</option><option value="instagram">Instagram</option><option value="email">mail</option></select>
              <input name="sort" type="number" defaultValue={t.sort} className="sm" style={{ width: 64 }} aria-label="Order" />
              <textarea name="body" defaultValue={t.body} rows={2} maxLength={2000} style={{ gridColumn: "1 / -1" }} aria-label="Text" />
              <div className="row" style={{ gap: 6, gridColumn: "1 / -1" }}>
                <button className="btn line sm">Save</button>
                <button className="btn quiet sm" formAction={deleteTemplate}>Remove</button>
              </div>
            </form>
          ))}
          <form action={saveTemplate} className="tmplrow">
            <input name="title" placeholder="New quick reply — title" maxLength={80} required />
            <select name="lang" defaultValue="sv" className="sm" aria-label="Language"><option value="sv">sv</option><option value="en">en</option><option value="ko">ko</option></select>
            <select name="channel" defaultValue="any" className="sm" aria-label="Channel"><option value="any">any</option><option value="instagram">Instagram</option><option value="email">mail</option></select>
            <input name="sort" type="number" defaultValue={100} className="sm" style={{ width: 64 }} aria-label="Order" />
            <textarea name="body" placeholder="Text" rows={2} maxLength={2000} style={{ gridColumn: "1 / -1" }} required />
            <div style={{ gridColumn: "1 / -1" }}><SubmitButton className="btn line sm" pendingText="…">Add</SubmitButton></div>
          </form>
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Sorting and keeping</h2>
          <form action={saveInboxSettings} className="stack" style={{ gap: 10 }}>
            <label className="fld"><span>Notification senders — mail from these domains is filed as &ldquo;Notification&rdquo; and folded away (one per line or comma-separated)</span>
              <textarea name="notify_domains" rows={3} defaultValue={((settings?.notify_domains ?? []) as string[]).join("\n")} disabled={!canEdit} /></label>
            <label className="fld"><span>Keep finished conversations for (months) — the originals stay in Gmail and Instagram</span>
              <input type="number" name="inbox_retention_months" min={1} max={60} defaultValue={settings?.inbox_retention_months ?? 12} disabled={!canEdit} style={{ width: 100 }} /></label>
            <label className="fld"><span>Instagram token expires on (the long-lived token lasts 60 days — note the date when you make one)</span>
              <input type="date" name="ig_token_expires_at" defaultValue={exp ?? ""} disabled={!canEdit} style={{ width: 180 }} /></label>
            {canEdit && <div><SubmitButton className="btn" pendingText="Saving…">Save</SubmitButton></div>}
          </form>
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Connections</h2>
          <div className="kv">
            <div>Instagram</div>
            <div>{igConfigured() ? <span className="tag" style={{ background: "var(--green)" }}>configured</span> : <span className="tag">not configured — IG_ACCESS_TOKEN / IG_USER_ID missing in Vercel</span>}
              {daysLeft !== null && <span className={`small ${daysLeft <= 7 ? "err-text" : "muted"}`}> · token {daysLeft < 0 ? `expired ${-daysLeft} d ago` : `${daysLeft} d left`}</span>}
              <div className="muted small">Webhook URL for Meta: <span className="mono">{appUrl}/api/inbound/instagram</span> · field <span className="mono">messages</span></div>
            </div>
            <div>Mail</div>
            <div><div className="muted small">Google Admin → Gmail → Routing: copy mail for <span className="mono">manager@minhwa.org</span> to <span className="mono">manager@in.minhwa.org</span> (same as the receipt@ rule). Resend posts to <span className="mono">{appUrl}/api/inbound/mail</span>.</div></div>
          </div>
        </div>
      </div>
    </main>
  );
}
