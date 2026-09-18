import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hm, longDate, parseISODate, sessionLabel, toISODate } from "@/lib/dates";
import { cancelBooking } from "@/app/actions";
import { ChargeTag, Notice, TopNav } from "@/app/components";

export default async function MePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const todayISO = toISODate(new Date());
  const { data: bookings } = await supabase.from("bookings")
    .select("id, date, status, slot:slots(id, session, start_time, end_time), charge:charges(id, amount_sek, status)")
    .eq("member_id", me.id).eq("status", "booked").gte("date", todayISO).order("date");
  const { data: settings } = await supabase.from("settings").select("cancel_deadline_days").eq("id", 1).single();
  const list = bookings ?? [];

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>My seats</h1><div className="muted small">{me.name}</div></div>
        <TopNav current="me" isAdmin={me.role === "admin"} />
      </div>
      <div className="stack">
        <Notice error={error} ok={ok} />
        {list.length === 0 && (
          <div className="card dashed" style={{ padding: 24, textAlign: "center" }}>
            No upcoming seats. <Link href="/" style={{ color: "var(--red)", fontWeight: 600 }}>Pick one on the board</Link>.
          </div>
        )}
        {list.map((b) => {
          const slot = b.slot as unknown as { id: string; session: "day" | "evening"; start_time: string; end_time: string };
          const charge = b.charge as unknown as { id: string; amount_sek: number; status: string } | null;
          return (
            <div key={b.id} className={`card stack person ${charge?.status === "paid" ? "paid" : charge?.status === "pending" ? "pending" : ""}`} style={{ gap: 10, alignItems: "stretch", flexDirection: "column" }}>
              <div className="row between">
                <div>
                  <div className="bold">{longDate(parseISODate(b.date))}</div>
                  <div className="muted small">{sessionLabel(slot.session)} · {hm(slot.start_time)} – {hm(slot.end_time)}</div>
                </div>
                <ChargeTag status={charge?.status} />
              </div>
              <div className="row" style={{ gap: 8 }}>
                {charge?.status === "unpaid" && <Link href={`/pay/${b.id}`} className="btn red sm">Pay {charge.amount_sek} kr</Link>}
                {charge?.status === "pending" && <Link href={`/pay/${b.id}`} className="btn line sm">Details</Link>}
                <Link href={`/slot/${slot.id}/${b.date}`} className="btn line sm">Who&apos;s coming</Link>
                <form action={cancelBooking} className="grow" style={{ display: "flex", justifyContent: "flex-end" }}>
                  <input type="hidden" name="booking_id" value={b.id} />
                  <input type="hidden" name="back" value="/me" />
                  <button className="btn quiet sm">Cancel</button>
                </form>
              </div>
            </div>
          );
        })}
        <div className="muted small">Cancelling is free until {settings?.cancel_deadline_days ?? 1} day{(settings?.cancel_deadline_days ?? 1) === 1 ? "" : "s"} before the session.</div>
      </div>
    </main>
  );
}
