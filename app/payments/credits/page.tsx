import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments, hasRole, roleLabels } from "@/lib/roles";
import { parseISODate, shortDate } from "@/lib/dates";
import { CREDIT_KIND_LABEL, CREDIT_YEAR_NOTICE, credits, creditText, signed, type CreditBalance, type CreditLine } from "@/lib/credits";
import { adjustCredits, giveCredits, voidCredits } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";

type Q = { error?: string; ok?: string; m?: string; c?: string };
type MemberOpt = { id: string; name: string; roles: string[] | null; active: boolean };
type EventOpt = { id: string; title: string; date: string };

function okText(q: Q, name?: string): string | undefined {
  if (q.ok === "credits_given" && q.c) return `${credits(q.c)} given${name ? ` to ${name}` : ""}.`;
  return undefined;
}

function HistoryRow({ l, back, showName, balance }: { l: CreditLine; back: string; showName?: boolean; balance: number }) {
  const voided = !!l.voided_at;
  // taking back is possible only while the member still has the credits
  const canTakeBack = !voided && (l.kind === "grant" || l.kind === "adjust") && balance - l.amount >= 0;
  return (
    <div className={`txrow ${voided ? "voided" : ""}`}>
      <div className="muted small">{shortDate(new Date(l.created_at))}</div>
      <div style={{ minWidth: 0 }}>
        {showName && <><Link href={`/payments/credits?m=${l.member_id}`} className="bold">{l.member_name}</Link><span className="muted"> · </span></>}
        <span className={showName ? "" : "bold"}>{creditText(l)}</span>
        <span className="muted small"> · {CREDIT_KIND_LABEL[l.kind]}{l.created_by_name && (l.kind === "grant" || l.kind === "adjust") ? ` by ${l.created_by_name}` : ""}</span>
        {voided && <span className="muted small"> · taken back {shortDate(new Date(l.voided_at!))}{l.voided_by_name ? ` by ${l.voided_by_name}` : ""}</span>}
      </div>
      <div className={`amt ${l.amount > 0 ? "plus" : "minus"}`}>{signed(l.amount)}</div>
      {canTakeBack && (
        <div className="actions">
          <form action={voidCredits}>
            <input type="hidden" name="movement_id" value={l.id} />
            <input type="hidden" name="back" value={back} />
            <button className="btn quiet sm" title="Remove these credits from the member's balance">Take back</button>
          </form>
        </div>
      )}
    </div>
  );
}

export default async function CreditsPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  const q = await searchParams;
  const m = q.m && /^[0-9a-f-]{36}$/i.test(q.m) ? q.m : null;

  const supabase = await createClient();
  const [{ data: memberRows }, { data: balRows }, { data: eventRows }, { data: histRows }] = await Promise.all([
    supabase.from("members").select("id, name, roles, active").eq("active", true).order("name"),
    supabase.from("credit_balances").select("*").order("name"),
    supabase.rpc("credit_events"),
    m
      ? supabase.from("credit_history").select("*").eq("member_id", m).order("created_at", { ascending: false }).limit(300)
      : supabase.from("credit_history").select("*").order("created_at", { ascending: false }).limit(30),
  ]);
  const members = (memberRows ?? []) as MemberOpt[];
  const balances = (balRows ?? []) as CreditBalance[];
  const events = (eventRows ?? []) as EventOpt[];
  const history = (histRows ?? []) as CreditLine[];

  const owed = balances.reduce((s, b) => s + Number(b.balance), 0);
  const givenYear = balances.reduce((s, b) => s + Number(b.granted_this_year), 0);
  const holders = balances.filter((b) => Number(b.balance) > 0).length;
  const crew = members.filter((x) => hasRole(x, "crew"));
  const others = members.filter((x) => !hasRole(x, "crew"));
  const focus = m ? members.find((x) => x.id === m) ?? null : null;
  const focusBal = m ? balances.find((b) => b.member_id === m) ?? null : null;
  const focusName = focus?.name ?? focusBal?.name ?? history[0]?.member_name;
  const back = m ? `/payments/credits?m=${m}` : "/payments/credits";
  const balanceById = new Map(balances.map((b) => [b.member_id, Number(b.balance)]));
  const sorted = [...balances].sort((a, b) => Number(b.balance) - Number(a.balance) || a.name.localeCompare(b.name));

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Credits</h1><div className="muted small">Credits instead of pay for helping with activities · 1 credit = 1 kr · Treasurer and Admin</div></div>
        <TopNav current="payments" me={me} />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Notice error={q.error} ok={q.ok} text={okText(q, focusName)} />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Link href="/payments" className="btn line sm">← Payments</Link>
          {m && <Link href="/payments/credits" className="btn line sm">All members</Link>}
        </div>

        <div className="creditsum">
          <div className="card"><div className="muted small">Members hold</div><div className="amount">{credits(owed)}</div><div className="muted small">{holders} member{holders === 1 ? "" : "s"} · what the association still owes in goods and seats</div></div>
          <div className="card"><div className="muted small">Given this year</div><div className="amount">{credits(givenYear)}</div><div className="muted small">taken back grants not counted</div></div>
        </div>

        {/* give */}
        <form action={giveCredits} className="card stack" style={{ padding: 18 }}>
          <h2>Give credits</h2>
          <div className="cform">
            <label className="strong">Member
              <select name="member_id" defaultValue={m ?? ""} required>
                <option value="" disabled>— who —</option>
                {crew.length > 0 && <optgroup label="Crew">{crew.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</optgroup>}
                <optgroup label={crew.length ? "Everyone else" : "Members"}>{others.map((x) => <option key={x.id} value={x.id}>{x.name}{x.roles?.length ? ` · ${roleLabels(x.roles)}` : ""}</option>)}</optgroup>
              </select>
            </label>
            <label className="strong">Credits (= kr)<input name="amount" type="number" inputMode="numeric" min={1} max={10000} step={1} required placeholder="e.g. 200" /></label>
            <label><span>Activity <span style={{ opacity: 0.7 }}>(optional)</span></span>
              <select name="event_id" defaultValue="">
                <option value="">— none —</option>
                {events.map((e) => <option key={e.id} value={e.id}>{shortDate(parseISODate(e.date))} · {e.title}</option>)}
              </select>
            </label>
            <label>What for<input name="note" maxLength={200} placeholder="e.g. set up the art fair booth — empty = the activity's name" /></label>
            <div className="cbtns"><button className="btn ink sm">Give credits</button><span className="muted small">The member sees it at once under My seats → Credits. A mistake? &ldquo;Take back&rdquo; below, while the credits are unused.</span></div>
          </div>
        </form>

        {/* one member */}
        {m && (
          <section className="card stack paysect" style={{ padding: 18 }}>
            <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
              <h2>{focusName ?? "Member"}</h2>
              <div className="row" style={{ gap: 12 }}>
                {focusBal && Number(focusBal.granted_this_year) >= CREDIT_YEAR_NOTICE && <span className="tag pending" style={{ marginLeft: 0 }}>{credits(focusBal.granted_this_year)} given this year — check with the accountant</span>}
                <span className="amt">{credits(focusBal?.balance ?? 0)}</span>
              </div>
            </div>
            {history.length === 0 && <div className="muted small">No credits yet.</div>}
            {history.map((l) => <HistoryRow key={l.id} l={l} back={back} balance={balanceById.get(l.member_id) ?? 0} />)}
            <details>
              <summary className="muted small" style={{ cursor: "pointer" }}>Correct the balance</summary>
              <form action={adjustCredits} className="cform" style={{ marginTop: 8 }}>
                <input type="hidden" name="member_id" value={m} />
                <label className="strong">Credits, + or −<input name="amount" inputMode="text" required placeholder="e.g. 50 or -50" /></label>
                <label className="wide">Why<input name="note" maxLength={200} required placeholder="e.g. credits noted on paper before the app" /></label>
                <div className="cbtns"><button className="btn line sm">Correct</button><span className="muted small">For fixes only — use &ldquo;Give credits&rdquo; for work done. The balance can&apos;t go below 0.</span></div>
              </form>
            </details>
          </section>
        )}

        {/* balances */}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>Balances <span className={`count ${holders === 0 ? "zero" : ""}`}>{holders}</span></h2>
          {sorted.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>No one has credits yet.</div>}
          {sorted.map((b) => (
            <div key={b.member_id} className={`txrow ${b.member_id === m ? "focus" : ""}`}>
              <div className="muted small">{b.last_at ? shortDate(new Date(b.last_at)) : ""}</div>
              <div style={{ minWidth: 0 }}>
                <Link href={`/payments/credits?m=${b.member_id}`} className="bold">{b.name}</Link>
                <span className="muted small"> · {roleLabels(b.roles)} · given this year {credits(b.granted_this_year)}</span>
                {Number(b.granted_this_year) >= CREDIT_YEAR_NOTICE && <span className="tag pending" style={{ marginLeft: 6 }}>≥ {CREDIT_YEAR_NOTICE} kr this year</span>}
              </div>
              <div className="amt">{credits(b.balance)}</div>
            </div>
          ))}
        </section>

        {/* recent */}
        {!m && (
          <section className="card stack paysect" style={{ padding: 18 }}>
            <h2>Recent</h2>
            {history.length === 0 && <div className="muted small">Nothing yet.</div>}
            {history.map((l) => <HistoryRow key={l.id} l={l} back={back} showName balance={balanceById.get(l.member_id) ?? 0} />)}
          </section>
        )}

        <div className="muted small" style={{ padding: "0 4px" }}>
          Credits are paid for work, only in kind. When one person gets {CREDIT_YEAR_NOTICE} kr or more in a year, employer&apos;s fees and tax reporting may apply — check with the accountant. Unused credits are a debt of the association and belong in the year-end accounts.
        </div>
      </div>
    </main>
  );
}
