import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { isValidISODate, todayStockholm } from "@/lib/dates";
import { buyPass } from "@/app/actions";
import { Chevron, Notice } from "@/app/components";
import { PASS_KINDS, passWorks, periodLabel, periodName, shortDay, type PassKind, type PassOffer, type PassRow } from "@/lib/passes";
import { paymentLabel } from "@/lib/payments";

/** Choose and buy a monthly pass. /pass?period=2026-11-01 picks the period (default: the first one open). */
export default async function PassPage({ searchParams }: { searchParams: Promise<{ period?: string; error?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { period, error } = await searchParams;
  const supabase = await createClient();
  const today = todayStockholm();
  const [{ data: offerRows }, { data: settings }, { data: myRow }, { data: passRows }] = await Promise.all([
    supabase.rpc("pass_offer"),
    supabase.from("settings").select("seat_price_sek, pass_twice_sek, pass_unlimited_sek, pass_crew_sek, pass_twice_per_week, pass_max_upcoming").eq("id", 1).single(),
    supabase.from("members").select("crew_rate_until").eq("id", me.id).single(),
    supabase.from("passes_view").select("*").eq("member_id", me.id).eq("status", "active").gte("period_end", today).order("period_start"),
  ]);
  const offers = (offerRows ?? []) as PassOffer[];
  const mine = (passRows ?? []) as PassRow[];
  const open = offers.filter((o) => o.open);
  const chosen = (isValidISODate(period) && offers.find((o) => o.period_start === period)) || open[0] || offers[0] || null;
  const have = chosen ? mine.find((p) => p.period_start === chosen.period_start) ?? null : null;
  const crewUntil = (myRow as { crew_rate_until: string | null } | null)?.crew_rate_until ?? null;
  const crewOk = !!crewUntil && crewUntil >= today;
  const price: Record<PassKind, number> = {
    twice: settings?.pass_twice_sek ?? 550,
    unlimited: settings?.pass_unlimited_sek ?? 1000,
    crew: settings?.pass_crew_sek ?? 550,
  };
  const kinds = PASS_KINDS.filter((k) => k.key !== "crew" || crewOk);
  const canChange = !!have && have.payment_status === "pending";
  const defaultKind: PassKind = have?.kind ?? (crewOk ? "crew" : "twice");

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href="/me" className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> Back to My seats</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>Monthly pass</h1>
          <div className="muted">Pay once with Swish, then book without paying. Without a pass a session is {settings?.seat_price_sek ?? 100} kr as usual.</div>
        </div>
        <Notice error={error} />

        {!chosen && <div className="notice">Monthly passes are not open yet.</div>}

        {offers.length > 1 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {offers.map((o) => (
              <Link key={o.period_start} href={`/pass?period=${o.period_start}`} className={`pill ${chosen?.period_start === o.period_start ? "active" : ""}`}>
                {periodName(o.period_start, o.period_end)}
              </Link>
            ))}
          </div>
        )}

        {chosen && (
          <div className="card stack" style={{ gap: 6, padding: "14px 18px" }}>
            <div className="kv"><span className="k">Period</span><span className="v">{periodLabel(chosen.period_start, chosen.period_end)}</span></div>
            {!chosen.open && <div className="small" style={{ color: "var(--gold-text)" }}>Opens for buying on {shortDay(chosen.buy_from)}.</div>}
          </div>
        )}

        {have && !canChange && (
          <div className={`card stack person ${passWorks(have) ? "paid" : ""}`} style={{ gap: 8, alignItems: "stretch", flexDirection: "column", padding: "14px 18px" }}>
            <div className="row between"><b>{have.label}</b><span className="tag">{passWorks(have) ? "Active" : paymentLabel(have.payment_status)}</span></div>
            <div className="small muted">You have this pass for {periodName(have.period_start, have.period_end)}. {have.payment_status === "claimed" ? "The treasurer confirms the payment when it shows up in the bank — the pass works already." : ""}</div>
            <Link href={`/pass/${have.id}`} className="btn line sm">Details</Link>
          </div>
        )}

        {chosen && chosen.open && (!have || canChange) && (
          <form action={buyPass} className="stack" id="buy">
            <input type="hidden" name="period_start" value={chosen.period_start} />
            {canChange && <div className="notice">Your {have!.label} pass is not paid yet — you can still pick another one.</div>}
            {kinds.map((k) => (
              <label key={k.key} className="card row choice" style={{ alignItems: "flex-start", gap: 12, padding: "14px 16px", cursor: "pointer" }}>
                <input type="radio" name="kind" value={k.key} defaultChecked={k.key === defaultKind} required style={{ width: 20, height: 20, marginTop: 2, flexShrink: 0 }} />
                <span className="grow">
                  <span className="row between"><b>{k.label}</b><span className="bold">{price[k.key]} kr</span></span>
                  <span className="small muted" style={{ display: "block", marginTop: 2 }}>
                    {k.key === "twice"
                      ? `Up to ${settings?.pass_twice_per_week ?? 2} sessions a week (Mon–Fri). An extra session that week is ${settings?.seat_price_sek ?? 100} kr.`
                      : `Come as often as you like — up to ${settings?.pass_max_upcoming ?? 4} upcoming seats booked at a time.`}
                    {k.key === "crew" && crewUntil ? ` Your Crew rate runs until ${shortDay(crewUntil)}.` : ""}
                  </span>
                </span>
              </label>
            ))}
            <div className="footer" style={{ marginTop: 6 }}>
              <button className="btn red">{canChange ? "Change my pass" : "Buy and pay with Swish"}</button>
              <div className="muted small" style={{ textAlign: "center" }}>The pass works as soon as you tap &ldquo;I have paid&rdquo;. Seats you already booked in this period and haven&apos;t paid move onto it.</div>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
