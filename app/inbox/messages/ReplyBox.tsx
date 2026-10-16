"use client";
import { useState } from "react";
import { SubmitButton } from "@/app/SubmitButton";
import type { TemplateRow } from "@/lib/comms/types";

/** The Instagram reply box: a textarea, the quick replies that fill it, and the send button (locked while sending). */
export function ReplyBox({ action, threadId, templates, hidden, disabled, disabledText }: {
  action: (fd: FormData) => void | Promise<void>;
  threadId: string;
  templates: TemplateRow[];
  hidden: Record<string, string>;
  disabled: boolean;
  disabledText?: string;
}) {
  const [text, setText] = useState("");
  return (
    <form action={action} className="stack" style={{ gap: 8 }}>
      <input type="hidden" name="thread_id" value={threadId} />
      {Object.entries(hidden).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      {templates.length > 0 && (
        <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
          {templates.map((t) => (
            <button key={t.id} type="button" className="btn quiet sm" style={{ minHeight: 28, padding: "0 8px", fontSize: 12 }} title={t.body} onClick={() => setText((cur) => (cur ? `${cur}\n${t.body}` : t.body))}>{t.title} <span className="muted">{t.lang}</span></button>
          ))}
        </div>
      )}
      <textarea name="text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={disabled ? (disabledText ?? "Cannot answer here") : "Write a reply…"} disabled={disabled} maxLength={1000} className="grow" />
      <div className="row between" style={{ alignItems: "center" }}>
        <span className="muted small">{disabled ? disabledText : `${text.length}/1000 · sent as the association's Instagram account`}</span>
        {disabled ? <button type="button" className="btn" disabled>Cannot send</button> : <SubmitButton className="btn" pendingText="Sending…">Send</SubmitButton>}
      </div>
    </form>
  );
}
