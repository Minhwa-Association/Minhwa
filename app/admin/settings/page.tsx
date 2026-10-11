import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { WEEKDAYS_LONG, sessionLabel } from "@/lib/dates";
import { addMember, setCrewRate, setInstructor, setRoles, setSlotWhatsapp, updatePassSettings, updateSettings } from "@/app/actions";
import { todayStockholm, parseISODate, toISODate } from "@/lib/dates";
import { shortDay } from "@/lib/passes";
import { ROLES, hasRole } from "@/lib/roles";
import { Notice, TopNav } from "@/app/components";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!hasRole(me, "admin")) redirect("/");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: settings }, { data: slots }, { data: members }] = await Promise.all([
    supabase.from("settings").select("*").eq("id", 1).single(),
    supabase.from("slots").select("id, weekday, session, instructor_id, whatsapp_url").order("weekday").order("session"),
    supabase.from("members").select("id, name, phone, roles, auth_id, crew_rate_until").order("name"),
  ]);
  const teachers = (members ?? []).filter((m) => hasRole(m, "teacher"));
  const today = todayStockholm();
  const t = parseISODate(today);
  const in3months = toISODate(new Date(t.getFullYear(), t.getMonth() + 3, t.getDate()));
  // Crew rate list: members with a rate first, then Crew, then everyone else
  const rank = (m: { crew_rate_until: string | null; roles: string[] | null }) => (m.crew_rate_until && m.crew_rate_until >= today ? 0 : hasRole(m, "crew") ? 1 : 2);
  const crewList = [...(members ?? [])].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Settings</h1><div className="muted small"><Link href="/admin">← Back to the admin board</Link></div></div>
        <TopNav current="admin" me={me} />
      </div>
      <Notice error={error} ok={ok} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 20, marginTop: 12 }}>

        <form action={updateSettings} className="card stack" style={{ padding: 18 }}>
          <h2>Booking & Swish</h2>
          <div><label htmlFor="price">Price per session (kr)</label><input id="price" name="seat_price_sek" type="number" min={0} defaultValue={settings?.seat_price_sek} /></div>
          <div><label htmlFor="swish">Association Swish number</label><input id="swish" name="swish_number" defaultValue={settings?.swish_number} /></div>
          <div><label htmlFor="payee">Name shown in Swish</label><input id="payee" name="swish_payee_name" defaultValue={settings?.swish_payee_name} /></div>
          <div><label htmlFor="win">Members can book this many weeks ahead</label><input id="win" name="booking_window_weeks" type="number" min={1} max={12} defaultValue={settings?.booking_window_weeks} /></div>
          <div><label htmlFor="cancel">Free cancellation until (days before)</label><input id="cancel" name="cancel_deadline_days" type="number" min={0} max={14} defaultValue={settings?.cancel_deadline_days} /></div>
          <div className="muted small">Full sessions: members join a waiting list instead of booking extra seats — the first in line gets a freed seat automatically and pays then.</div>
          <div><label htmlFor="krw">Store price rule — won per krona <span style={{ opacity: 0.7 }}>(100 → ₩10,000 costs 100 kr; the gap to the real rate covers shipping, customs and VAT)</span></label><input id="krw" name="price_krw_per_sek" type="number" min={1} max={1000} defaultValue={settings?.price_krw_per_sek ?? 100} /></div>
          <button className="btn ink">Save settings</button>
        </form>

        <form action={updatePassSettings} className="card stack" style={{ padding: 18 }}>
          <h2>Monthly passes</h2>
          <div className="muted small">Members pay once and book without paying. A pass works from &ldquo;I have paid&rdquo;; credits can&apos;t be used for it. Crew Unlimited is only for members with a Crew rate (below).</div>
          <div className="row" style={{ gap: 8 }}>
            <div className="grow"><label htmlFor="p2">Twice a week (kr)</label><input id="p2" name="pass_twice_sek" type="number" min={0} defaultValue={settings?.pass_twice_sek ?? 550} /></div>
            <div className="grow"><label htmlFor="pu">Unlimited (kr)</label><input id="pu" name="pass_unlimited_sek" type="number" min={0} defaultValue={settings?.pass_unlimited_sek ?? 1000} /></div>
            <div className="grow"><label htmlFor="pc">Crew Unlimited (kr)</label><input id="pc" name="pass_crew_sek" type="number" min={0} defaultValue={settings?.pass_crew_sek ?? 550} /></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div className="grow"><label htmlFor="pw">Twice a week: sessions per week</label><input id="pw" name="pass_twice_per_week" type="number" min={1} max={10} defaultValue={settings?.pass_twice_per_week ?? 2} /></div>
            <div className="grow"><label htmlFor="pm">Unlimited: upcoming seats at a time</label><input id="pm" name="pass_max_upcoming" type="number" min={1} max={50} defaultValue={settings?.pass_max_upcoming ?? 4} /></div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <div className="grow"><label htmlFor="ps">Period starts on day</label><input id="ps" name="pass_start_day" type="number" min={1} max={28} defaultValue={settings?.pass_start_day ?? 1} /></div>
            <div className="grow"><label htmlFor="pp">On sale days before</label><input id="pp" name="pass_presale_days" type="number" min={0} max={27} defaultValue={settings?.pass_presale_days ?? 7} /></div>
            <div className="grow"><label htmlFor="pf">First period</label><input id="pf" name="passes_from" type="date" defaultValue={settings?.passes_from ?? "2026-11-01"} /></div>
          </div>
          <div className="muted small">Day 1 = calendar months (1–30 Nov). Passes already bought keep their dates if you change this.</div>
          <button className="btn ink">Save passes</button>
        </form>

        <div className="card stack" style={{ padding: 18 }} id="crew-rate">
          <h2>Crew rate</h2>
          <div className="muted small">Who may buy Crew Unlimited, and until when. After the date they can&apos;t buy it again — a pass already bought runs to the end of its period. Separate from the Crew role (Calendar).</div>
          {crewList.map((m) => {
            const active = !!m.crew_rate_until && m.crew_rate_until >= today;
            return (
              <div key={m.id} className="memberrow">
                <div className="grow" style={{ minWidth: 140 }}>
                  <div style={{ fontWeight: 600 }}>{m.name}{hasRole(m, "crew") ? <span className="muted small"> · Crew</span> : null}</div>
                  <div className="small" style={{ color: active ? "var(--green-text)" : "var(--muted)" }}>{active ? `Crew rate until ${shortDay(m.crew_rate_until!)}` : m.crew_rate_until ? `Ended ${shortDay(m.crew_rate_until)}` : "No Crew rate"}</div>
                </div>
                <form action={setCrewRate} className="row" style={{ gap: 6 }}>
                  <input type="hidden" name="member_id" value={m.id} />
                  <input name="crew_rate_until" type="date" defaultValue={active ? m.crew_rate_until! : in3months} className="inline" style={{ width: 150 }} aria-label={`Crew rate end date for ${m.name}`} />
                  <button className="btn line sm">{active ? "Change" : "Give"}</button>
                </form>
                {active && (
                  <form action={setCrewRate}>
                    <input type="hidden" name="member_id" value={m.id} />
                    <input type="hidden" name="crew_rate_until" value="" />
                    <button className="btn quiet sm">Remove</button>
                  </form>
                )}
              </div>
            );
          })}
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Teachers per slot</h2>
          <div className="muted small">Only members ticked as Teacher (see Members) show up here.</div>
          {(slots ?? []).map((s) => (
            <form key={s.id} action={setInstructor} className="row" style={{ gap: 8 }}>
              <input type="hidden" name="slot_id" value={s.id} />
              <div style={{ width: 130, fontWeight: 600, fontSize: 14 }}>{WEEKDAYS_LONG[s.weekday - 1].slice(0, 3)} {sessionLabel(s.session)}</div>
              <select name="instructor_id" defaultValue={s.instructor_id ?? ""} className="grow">
                <option value="">— none —</option>
                {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <button className="btn line sm">Set</button>
            </form>
          ))}
        </div>

        <form action={addMember} className="card stack" style={{ padding: 18 }}>
          <h2>Add a member or teacher</h2>
          <div className="muted small">Pre-register by phone. When they log in with that number for the first time, their account links to this entry automatically.</div>
          <div><label htmlFor="nm">Name</label><input id="nm" name="name" required placeholder="Anna Lind" /></div>
          <div><label htmlFor="ph">Mobile number</label><input id="ph" name="phone" type="tel" required placeholder="070 123 45 67" /></div>
          <div>
            <label>Roles (optional — everyone is a member)</label>
            <div className="checks">
              {ROLES.map((r) => (
                <label key={r.key} className="check"><input type="checkbox" name="roles" value={r.key} /> {r.label}</label>
              ))}
            </div>
          </div>
          <button className="btn ink">Add</button>
        </form>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>WhatsApp group per slot</h2>
          <div className="muted small">In WhatsApp: group → Group info → Invite via link → Copy link. Members see an &ldquo;Open WhatsApp group&rdquo; button on that slot.</div>
          {(slots ?? []).map((s) => (
            <form key={s.id} action={setSlotWhatsapp} className="row" style={{ gap: 8 }}>
              <input type="hidden" name="slot_id" value={s.id} />
              <div style={{ width: 130, fontWeight: 600, fontSize: 14 }}>{WEEKDAYS_LONG[s.weekday - 1].slice(0, 3)} {sessionLabel(s.session)}</div>
              <input name="whatsapp_url" type="url" placeholder="https://chat.whatsapp.com/…" defaultValue={s.whatsapp_url ?? ""} className="grow" />
              <button className="btn line sm">Set</button>
            </form>
          ))}
        </div>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Members</h2>
          <div className="muted small">Everyone is a member. Tick any extra roles — one person can hold several. Teacher: can be set on a slot · Crew: prepares and runs activities (sees the Calendar) · Treasurer: the Payments tab (bank statement, confirmations) · Admin: this board and settings.</div>
          {(members ?? []).map((m) => (
            <form key={m.id} action={setRoles} className="memberrow">
              <input type="hidden" name="member_id" value={m.id} />
              <div className="grow"><div style={{ fontWeight: 600 }}>{m.name}</div><div className="muted small">{m.phone}{m.auth_id ? "" : " · not logged in yet"}</div></div>
              <div className="checks">
                {ROLES.map((r) => (
                  <label key={r.key} className="check"><input type="checkbox" name="roles" value={r.key} defaultChecked={hasRole(m, r.key)} /> {r.label}</label>
                ))}
              </div>
              <button className="btn line sm">Set</button>
            </form>
          ))}
        </div>
      </div>
    </main>
  );
}
