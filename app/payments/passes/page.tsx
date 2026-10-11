import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { isValidISODate, todayStockholm } from "@/lib/dates";
import { cancelPass } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { kr, paymentLabel } from "@/lib/payments";
import { PASS_KINDS, passWorks, periodLabel, periodName, type PassOffer, type PassRow } from "@/lib/passes";

/** Treasurer / Admin: monthly passes per period. /payments/passes?period=2026-11-01 */
export default async function PassesPage({ searchParams }: { searchParams: Promise<{ period?: string; error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  const { period, error, ok } = await searchParams;
  const supabase = await createClient();
  const today = todayStockholm();
  const [{ data: offerRows }, { data: startRows }] = await Promise.all([
    supabase.rpc("pass_offer"),
    supabase.from("passes").select("period_start, period_end").order("period_start", { ascending: false }).limit(200),
  ]);
  // periods: every one that has passes + the current / next one
  const periods = new Map<string, string>();
  for (const o of (offerRows ?? []) as PassOffer[]) periods.set(o.period_start, o.period_end);
  for (const r of (startRows ?? []) as { period_start: string; period_end: string }[]) periods.set(r.period_start, r.period_end);
  const list = [...periods.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const current = list.find(([s, e]) => s <= today && e >= today)?.[0] ?? list[list.length - 1]?.[0];
  const chosen = isValidISODate(period) && periods.has(period) ? period : current;
  const { data: rows } = chosen
    ? await supabase.from("passes_view").select("*").eq("period_start", chosen).order("status").order("member_name")
    : { data: [] };
  const passes = (rows ?? []) as PassRow[];
  const live = passes.filter((p) => p.status === "active");
  const gone = passes.filter((p) => p.status !== "active");
  const back = `/payments/passes${chosen ? `?period=${chosen}` : ""}`;
  const paidSum = live.filter((p) => p.payment_status === "confirmed").reduce((s, p) => s + p.price_sek, 0);
  const waitSum = live.filter((p) => p.payment_status !== "confirmed").reduce((s, p) => s + p.price_sek, 0);

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Monthly passes</h1><div className="muted small"><Link href="/payments">← Payments</Link> · a pass payment is matched with the bank like any other (code P…)</div></div>
        <TopNav current="payments" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Notice error={error} ok={ok} />
        {list.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>No pass periods yet.</div>}
        {list.length > 0 && (
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            {list.map(([s, e]) => (
              <Link key={s} href={`/payments/passes?period=${s}`} className={`pill ${s === chosen ? "active" : ""}`}>{periodName(s, e)}{s <= today && e >= today ? " · now" : ""}</Link>
            ))}
          </div>
        )}
        {chosen && (
          <div className="card row between" style={{ padding: "12px 16px", flexWrap: "wrap", gap: 12 }}>
            <div className="small"><b>{periodLabel(chosen, periods.get(chosen)!)}</b></div>
            <div className="small row" style={{ gap: 14, flexWrap: "wrap" }}>
              {PASS_KINDS.map((k) => <span key={k.key}>{k.label}: <b>{live.filter((p) => p.kind === k.key).length}</b></span>)}
              <span>Paid: <b>{kr(paidSum)}</b></span>
              {waitSum > 0 && <span className="muted">Not confirmed yet: {kr(waitSum)}</span>}
            </div>
          </div>
        )}

        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>Passes <span className={`count ${live.length === 0 ? "zero" : ""}`}>{live.length}</span></h2>
          <div className="muted small">Money never came? <b>Cancel</b> — every seat on the pass goes back to 100 kr unpaid. Paid and the member stops? <b>Refund</b> — seats from today on go back to 100 kr; send the money back with Swish yourself.</div>
          {live.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>No passes for this period.</div>}
          {live.map((p) => (
            <div key={p.id} className="txrow">
              <div className="muted small">{p.code}</div>
              <div style={{ minWidth: 0 }}>
                <b>{p.member_name}</b><span className="muted"> · {p.label}</span>
                <div className="muted small">{passWorks(p) ? "works" : "not working yet"} · {paymentLabel(p.payment_status)} · {p.seats} seat{p.seats === 1 ? "" : "s"} on it{p.seats_upcoming ? ` (${p.seats_upcoming} upcoming)` : ""}</div>
              </div>
              <div className="amt">{kr(p.price_sek)}</div>
              <div className="actions">
                <form action={cancelPass}>
                  <input type="hidden" name="pass_id" value={p.id} />
                  <input type="hidden" name="back" value={back} />
                  <button className="btn quiet sm">{p.payment_status === "confirmed" ? "Refund" : "Cancel"}</button>
                </form>
              </div>
            </div>
          ))}
        </section>

        {gone.length > 0 && (
          <details className="card paysect" style={{ padding: 18 }}>
            <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Cancelled / refunded</h2><span className="muted small" style={{ marginLeft: 10 }}>{gone.length}</span></summary>
            <div className="stack" style={{ marginTop: 12 }}>
              {gone.map((p) => (
                <div key={p.id} className="txrow">
                  <div className="muted small">{p.code}</div>
                  <div style={{ minWidth: 0 }}><b>{p.member_name}</b><span className="muted"> · {p.label} · {paymentLabel(p.payment_status)}</span></div>
                  <div className="amt">{kr(p.price_sek)}</div>
                  <div className="actions" />
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </main>
  );
}
