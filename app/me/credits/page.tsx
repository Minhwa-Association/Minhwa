import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { roleLabels } from "@/lib/roles";
import { shortDate } from "@/lib/dates";
import { CREDIT_KIND_LABEL, credits, creditText, signed, type CreditBalance, type CreditLine } from "@/lib/credits";
import { Notice, TopNav } from "@/app/components";

export default async function MyCreditsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: bal }, { data: rows }] = await Promise.all([
    supabase.from("credit_balances").select("*").eq("member_id", me.id).maybeSingle(),
    supabase.from("credit_history").select("*").eq("member_id", me.id).is("voided_at", null).order("created_at", { ascending: false }).limit(200),
  ]);
  const b = bal as CreditBalance | null;
  const lines = (rows ?? []) as CreditLine[];

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Credits</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
        <TopNav current="me" me={me} />
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <Notice error={error} ok={ok} />
        <div className="muted small"><Link href="/me" style={{ fontWeight: 600 }}>← My seats</Link></div>

        <section className="card stack" style={{ padding: 18, gap: 8 }}>
          <div className="kv"><span className="k">Your balance</span><span className="amount">{credits(b?.balance ?? 0)}</span></div>
          <div className="muted small">
            The association gives credits for helping with its activities. 1 credit = 1 kr, and they do not expire.
            Use them in the <Link href="/store" style={{ fontWeight: 600 }}>Store</Link> (tick &ldquo;Use my credits&rdquo; when you order) or for a seat (&ldquo;Pay with credits&rdquo; after booking).
            Credits cover what they can — Swish pays the rest. If a booking or order is cancelled, the credits come back.
          </div>
        </section>

        <section className="card stack" style={{ padding: 18 }}>
          <h2>History</h2>
          {lines.length === 0 && <div className="muted small">Nothing yet.</div>}
          {lines.map((l) => (
            <div key={l.id} className="txrow">
              <div className="muted small">{shortDate(new Date(l.created_at))}</div>
              <div style={{ minWidth: 0 }}>
                <span className="bold">{creditText(l)}</span>
                <span className="muted small"> · {CREDIT_KIND_LABEL[l.kind]}</span>
              </div>
              <div className={`amt ${l.amount > 0 ? "plus" : "minus"}`}>{signed(l.amount)}</div>
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}
