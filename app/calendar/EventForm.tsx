import { AUDIENCES, audienceToKey, type EventRow } from "@/lib/calendar";
import { hm } from "@/lib/dates";

/** Shared form for a new event and for editing one. */
export function EventForm({
  action, event, submitLabel, defaultDate,
}: {
  action: (formData: FormData) => Promise<void>;
  event?: EventRow;
  submitLabel: string;
  defaultDate?: string;
}) {
  return (
    <form action={action} className="card stack" style={{ padding: 18 }}>
      {event && <input type="hidden" name="event_id" value={event.id} />}
      <div>
        <label htmlFor="title">Title</label>
        <input id="title" name="title" required maxLength={120} defaultValue={event?.title ?? ""} placeholder="Autumn exhibition" />
      </div>
      <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
        <div className="grow">
          <label htmlFor="date">Date</label>
          <input id="date" name="date" type="date" required defaultValue={event?.date ?? defaultDate ?? ""} />
        </div>
        <div className="grow">
          <label htmlFor="end_date">Last day <span style={{ opacity: 0.7 }}>(if more than one day)</span></label>
          <input id="end_date" name="end_date" type="date" defaultValue={event?.end_date ?? ""} />
        </div>
      </div>
      <div className="checks">
        <label className="check"><input type="checkbox" name="all_day" defaultChecked={event ? !event.start_time : false} /> All day</label>
      </div>
      <div className="row" style={{ gap: 8, alignItems: "flex-end" }}>
        <div className="grow">
          <label htmlFor="start_time">From</label>
          <input id="start_time" name="start_time" type="time" step={300} defaultValue={event?.start_time ? hm(event.start_time) : ""} />
        </div>
        <div className="grow">
          <label htmlFor="end_time">To <span style={{ opacity: 0.7 }}>(optional)</span></label>
          <input id="end_time" name="end_time" type="time" step={300} defaultValue={event?.end_time ? hm(event.end_time) : ""} />
        </div>
      </div>
      <div>
        <label htmlFor="location">Place <span style={{ opacity: 0.7 }}>(optional)</span></label>
        <input id="location" name="location" maxLength={160} defaultValue={event?.location ?? ""} placeholder="Studio · Sveavägen 1" />
      </div>
      <div>
        <label htmlFor="notes">Notes <span style={{ opacity: 0.7 }}>(optional)</span></label>
        <textarea id="notes" name="notes" maxLength={2000} defaultValue={event?.notes ?? ""} placeholder="What to bring, who does what…" />
      </div>
      <div>
        <label htmlFor="audience">Who can see it</label>
        <select id="audience" name="audience" defaultValue={audienceToKey(event?.audience)}>
          {AUDIENCES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
        </select>
        <div className="muted small" style={{ marginTop: 4 }}>Admins always see every event. Members only see &ldquo;Everyone&rdquo; events.</div>
      </div>
      <button className="btn ink">{submitLabel}</button>
    </form>
  );
}
