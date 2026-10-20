import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hasRole } from "@/lib/roles";
import { addDays, isValidISODate, longDate, parseISODate, sessionLabel, todayStockholm, toISODate } from "@/lib/dates";
import { shortDay } from "@/lib/passes";
import { credits } from "@/lib/credits";
import { createClosure, reopenClosure } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";

/**
 * Admin → Holidays (v19.2). Close days — the whole day, or only Day or Evening — so nobody can book.
 * Two steps: "Check" shows what closing would cancel (nothing changes), "Close these days" does it.
 * Seats already booked are cancelled like the admin's ×: paid → credits, "I have paid" → credits when the
 * treasurer confirms, unpaid → cancelled, monthly pass → freed. Waiting lists on those days are closed.
 */

type Closure = { id: string; date_from: string; date_to: string; session: "day" | "evening" | null; reason: string; created_at: string; reopened_at: string | null };
type PreviewRow = { date: string; session: "day" | "evening"; member_name: string; state: "paid" | "claimed" | "unpaid" | "pass" | "waiting"; amount: number };

const STATE_TEXT: Record<PreviewRow["state"], string> = {
  paid: "paid → credits",
  claimed: "awaiting confirmation → credits when confirmed",
  unpaid: "not paid → cancelled",
  pass: "monthly pass → freed",
  waiting: "waiting list → taken off",
};

function rangeText(from: string, to: string): string {
  return from === to ? longDate(parseISODate(from)) : `${longDate(parseISODate(from))} – ${longDate(parseISODate(to))}`;
}
function whichText(session: "day" | "evening" | null): string {
  return session ? `${sessionLabel(session)} only` : "whole day";
}
/** Mon–Fri sessions in the range, from today on. */
function sessionsIn(from: string, to: string, session: "day" | "evening" | null, today: string): number {
  let n = 0;
  for (let d = parseISODate(from > today ? from : today); toISODate(d) <= to; d = addDays(d, 1)) {
    const wd = d.getDay();
    if (wd >= 1 && wd <= 5) n += session ? 1 : 2;
  }
  return n;
}

export default async function HolidaysPage({ searchParams }: {
  searchParams: Promise<{ from?: string; to?: string; session?: string; reason?: string; error?: string; ok?: string; n?: string; cr?: string; cl?: string; w?: string }>;
}) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  const sp = await searchParams;
  const today = todayStockholm();
  const from = isValidISODate(sp.from) ? sp.from : "";
  const to = isValidISODate(sp.to) ? sp.to : from;
  const session = sp.session === "day" || sp.session === "evening" ? sp.session : null;
  const reason = (sp.reason ?? "").trim().slice(0, 60);
  const asked = !!from;
  const askError = !asked ? null
    : to < from ? "The last day is before the first day."
    : to < today ? "These days have passed already."
    : !reason ? "Write a short reason — members see it on the board (e.g. Christmas, Höstlov)."
    : null;

  const supabase = await createClient();
  const [{ data: closureRows, error: closuresErr }, preview] = await Promise.all([
    supabase.from("closures").select("id, date_from, date_to, session, reason, created_at, reopened_at").order("date_from", { ascending: false }).limit(60),
    asked && !askError ? supabase.rpc("closure_preview", { p_from: from, p_to: to, p_session: session }) : Promise.resolve({ data: null, error: null }),
  ]);
  const all = (closureRows ?? []) as Closure[];
  const upcoming = all.filter((c) => !c.reopened_at && c.date_to >= today).sort((a, b) => (a.date_from < b.date_from ? -1 : 1));
  const earlier = all.filter((c) => c.reopened_at || c.date_to < today).slice(0, 10);
  const ids = all.map((c) => c.id);
  const { data: cancelledRows } = ids.length
    ? await supabase.from("bookings").select("closure_id").in("closure_id", ids)
    : { data: [] as { closure_id: string }[] };
  const cancelledBy = new Map<string, number>();
  for (const r of (cancelledRows ?? []) as { closure_id: string }[]) cancelledBy.set(r.closure_id, (cancelledBy.get(r.closure_id) ?? 0) + 1);

  const rows = (preview.data ?? []) as PreviewRow[];
  const count = (s: PreviewRow["state"]) => rows.filter((r) => r.state === s).length;
  const paidCredits = rows.filter((r) => r.state === "paid").reduce((a, r) => a + r.amount, 0);
  const seatCount = rows.filter((r) => r.state !== "waiting").length;
  const byDay = new Map<string, PreviewRow[]>();
  for (const r of rows) {
    const k = `${r.date}|${r.session}`;
    byDay.set(k, [...(byDay.get(k) ?? []), r]);
  }

  const okText = sp.ok === "closed"
    ? [
        "Closed — nobody can book these days.",
        Number(sp.n) > 0 ? `${sp.n} seat${sp.n === "1" ? "" : "s"} cancelled.` : "No seats were booked.",
        Number(sp.cr) > 0 ? `${credits(sp.cr)} given back.` : "",
        Number(sp.cl) > 0 ? `${sp.cl} awaiting confirmation — credits when the treasurer confirms.` : "",
        Number(sp.w) > 0 ? `${sp.w} taken off a waiting list.` : "",
        Number(sp.n) > 0 || Number(sp.w) > 0 ? "Tell the members in the WhatsApp groups." : "",
      ].filter(Boolean).join(" ")
    : sp.ok === "reopened" ? "Reopened — members can book these days again. Seats it cancelled stay cancelled."
    : undefined;

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Holidays</h1><div className="muted small"><Link href="/admin">← Back to the admin board</Link></div></div>
        <TopNav current="admin" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Notice error={sp.error ?? (preview.error ? preview.error.message : undefined)} text={okText} />

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 20 }}>
          <form action="/admin/holidays" className="card stack" style={{ padding: 18 }}>
            <h2>Close days</h2>
            <div className="muted small">Nobody can book a seat or join a waiting list on these days. Seats already booked are cancelled — what was paid comes back as credits. You check first; nothing changes until you confirm.</div>
            <div className="row" style={{ gap: 8 }}>
              <div className="grow"><label htmlFor="hf">First day</label><input id="hf" name="from" type="date" required min={today} defaultValue={from} /></div>
              <div className="grow"><label htmlFor="ht">Last day <span style={{ opacity: 0.7 }}>(empty = one day)</span></label><input id="ht" name="to" type="date" min={today} defaultValue={asked && to !== from ? to : ""} /></div>
            </div>
            <div><label htmlFor="hs">Which sessions</label>
              <select id="hs" name="session" defaultValue={session ?? "all"}>
                <option value="all">Whole day (Day and Evening)</option>
                <option value="day">Day only (10–16)</option>
                <option value="evening">Evening only (17–20)</option>
              </select>
            </div>
            <div><label htmlFor="hr">Reason <span style={{ opacity: 0.7 }}>(members see it on the board)</span></label><input id="hr" name="reason" maxLength={60} placeholder="Christmas · Höstlov · Studio closed" defaultValue={reason} /></div>
            <button className="btn ink">Check what it cancels</button>
          </form>

          {asked && (
            <div className="card stack" style={{ padding: 18 }}>
              <h2>Check</h2>
              {askError ? (
                <div className="notice err">{askError}</div>
              ) : preview.error ? null : (
                <>
                  <div>
                    <div className="bold">{rangeText(from, to)}</div>
                    <div className="muted small">{whichText(session)} · {sessionsIn(from, to, session, today)} session{sessionsIn(from, to, session, today) === 1 ? "" : "s"} closed · &ldquo;{reason}&rdquo;</div>
                  </div>
                  {rows.length === 0 ? (
                    <div className="notice">No seats booked and nobody waiting on these days — nothing to cancel.</div>
                  ) : (
                    <>
                      <div className="stack" style={{ gap: 4 }}>
                        {count("paid") > 0 && <div className="small"><b>{count("paid")}</b> paid seat{count("paid") === 1 ? "" : "s"} → <b>{credits(paidCredits)}</b> back to the members</div>}
                        {count("claimed") > 0 && <div className="small"><b>{count("claimed")}</b> awaiting confirmation → credits when the treasurer confirms</div>}
                        {count("unpaid") > 0 && <div className="small"><b>{count("unpaid")}</b> not paid → cancelled</div>}
                        {count("pass") > 0 && <div className="small"><b>{count("pass")}</b> on a monthly pass → freed</div>}
                        {count("waiting") > 0 && <div className="small"><b>{count("waiting")}</b> on a waiting list → taken off</div>}
                      </div>
                      <div className="stack" style={{ gap: 8 }}>
                        {[...byDay.entries()].map(([k, list]) => (
                          <div key={k}>
                            <div className="muted small" style={{ fontWeight: 600 }}>{longDate(parseISODate(list[0].date))} · {sessionLabel(list[0].session)}</div>
                            {list.map((r, i) => <div key={i} className="small">{r.member_name} — {STATE_TEXT[r.state]}{r.state === "paid" && r.amount > 0 ? ` (${r.amount} kr)` : ""}</div>)}
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <form action={createClosure} className="stack" style={{ gap: 8 }}>
                    <input type="hidden" name="from" value={from} />
                    <input type="hidden" name="to" value={to} />
                    <input type="hidden" name="session" value={session ?? "all"} />
                    <input type="hidden" name="reason" value={reason} />
                    <SubmitButton className="btn red" pendingText="Closing…">{seatCount > 0 ? `Close these days · cancel ${seatCount} seat${seatCount === 1 ? "" : "s"}` : "Close these days"}</SubmitButton>
                  </form>
                  <div className="muted small">Members see it on My seats and the board. The app sends no message — tell them in the WhatsApp groups.</div>
                </>
              )}
            </div>
          )}
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Coming up</h2>
          {closuresErr ? (
            <div className="notice err">Couldn&apos;t load the holidays. Has <span className="mono">sql/migration_v19_2_holidays.sql</span> been run in Supabase?</div>
          ) : upcoming.length === 0 ? (
            <div className="muted small">No holidays set.</div>
          ) : upcoming.map((c) => (
            <div key={c.id} className="memberrow">
              <div className="grow" style={{ minWidth: 180 }}>
                <div style={{ fontWeight: 600 }}>{rangeText(c.date_from, c.date_to)}</div>
                <div className="small muted">{whichText(c.session)} · &ldquo;{c.reason}&rdquo;{cancelledBy.get(c.id) ? ` · ${cancelledBy.get(c.id)} seat${cancelledBy.get(c.id) === 1 ? "" : "s"} cancelled` : ""}</div>
              </div>
              <Link href={`/?week=${c.date_from > today ? c.date_from : today}`} className="btn quiet sm">See on the board</Link>
              <form action={reopenClosure}>
                <input type="hidden" name="closure_id" value={c.id} />
                <SubmitButton className="btn line sm" pendingText="Reopening…" title="Members can book again. Seats it cancelled stay cancelled.">Reopen</SubmitButton>
              </form>
            </div>
          ))}
          {earlier.length > 0 && (
            <details>
              <summary className="muted small" style={{ cursor: "pointer" }}>Earlier and reopened</summary>
              <div className="stack" style={{ gap: 6, marginTop: 8 }}>
                {earlier.map((c) => (
                  <div key={c.id} className="small muted">
                    {shortDay(c.date_from)}{c.date_to !== c.date_from ? ` – ${shortDay(c.date_to)}` : ""} · {whichText(c.session)} · &ldquo;{c.reason}&rdquo;
                    {c.reopened_at ? ` · reopened ${shortDay(c.reopened_at.slice(0, 10))}` : ""}
                    {cancelledBy.get(c.id) ? ` · ${cancelledBy.get(c.id)} cancelled` : ""}
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </main>
  );
}
