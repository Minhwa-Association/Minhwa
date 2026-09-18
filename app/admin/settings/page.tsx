import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { WEEKDAYS_LONG, sessionLabel } from "@/lib/dates";
import { addMember, setInstructor, setRole, setSlotWhatsapp, updateSettings } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (me.role !== "admin") redirect("/");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: settings }, { data: slots }, { data: members }] = await Promise.all([
    supabase.from("settings").select("*").eq("id", 1).single(),
    supabase.from("slots").select("id, weekday, session, instructor_id, whatsapp_url").order("weekday").order("session"),
    supabase.from("members").select("id, name, phone, role, auth_id").order("name"),
  ]);
  const teachers = (members ?? []).filter((m) => m.role === "instructor" || m.role === "admin");

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Settings</h1><div className="muted small"><Link href="/admin">← Back to the admin board</Link></div></div>
        <TopNav current="admin" isAdmin />
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
          <div><label htmlFor="extra">Extra seats allowed beyond 5</label><input id="extra" name="max_extra_seats" type="number" min={0} max={20} defaultValue={settings?.max_extra_seats} /></div>
          <button className="btn ink">Save settings</button>
        </form>

        <div className="card stack" style={{ padding: 18 }}>
          <h2>Teachers per slot</h2>
          <div className="muted small">A teacher must be a member with the Teacher role (see Members).</div>
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
          <div><label htmlFor="rl">Role</label>
            <select id="rl" name="role" defaultValue="member">
              <option value="member">Member</option>
              <option value="instructor">Teacher</option>
              <option value="admin">Admin</option>
            </select>
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
          <div className="muted small">Pre-registered and logged-in members. Change a role to make someone a teacher or admin.</div>
          {(members ?? []).map((m) => (
            <form key={m.id} action={setRole} className="row" style={{ gap: 8 }}>
              <input type="hidden" name="member_id" value={m.id} />
              <div className="grow"><div style={{ fontWeight: 600 }}>{m.name}</div><div className="muted small">{m.phone}{m.auth_id ? "" : " · not logged in yet"}</div></div>
              <select name="role" defaultValue={m.role} style={{ width: 130 }}>
                <option value="member">Member</option>
                <option value="instructor">Teacher</option>
                <option value="admin">Admin</option>
              </select>
              <button className="btn line sm">Set</button>
            </form>
          ))}
        </div>
      </div>
    </main>
  );
}
