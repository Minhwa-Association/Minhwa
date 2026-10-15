import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { roleLabels } from "@/lib/roles";
import { shortDate } from "@/lib/dates";
import { describePayment, kr, paymentLabel, type PaymentRow } from "@/lib/payments";
import { credits } from "@/lib/credits";
import { LoadError, Notice, TopNav } from "@/app/components";
import { loadFailed } from "@/lib/loadError";
import { paidWith, type SalesReceipt } from "@/lib/receipts";

type ReceiptLite = Pick<SalesReceipt, "id" | "number" | "payment_id" | "paid_on" | "swish_sek" | "credit_sek" | "total_sek" | "voided_at">;

/** My payments — everything I have paid or still owe, with the receipt for each paid one (v17). */
export default async function MyPaymentsPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: payRows, error: payErr }, { data: receiptRows, error: recErr }] = await Promise.all([
    supabase.from("payments_view").select("*").eq("member_id", me.id).order("created_at", { ascending: false }).limit(150),
    supabase.from("sales_receipts").select("id, number, payment_id, paid_on, swish_sek, credit_sek, total_sek, voided_at").eq("member_id", me.id).order("issued_at", { ascending: false }).limit(300),
  ]);
  const head = (
    <div className="topbar">
      <div><h1>My payments</h1><div className="muted small">{me.name} · {roleLabels(me.roles)}</div></div>
      <TopNav current="me" me={me} />
    </div>
  );
  if (loadFailed("me/payments", { payments: payErr, receipts: recErr })) {
    return <main className="page">{head}<LoadError what="your payments" retry="/me/payments" /></main>;
  }
  const payments = (payRows ?? []) as PaymentRow[];
  const receipts = (receiptRows ?? []) as ReceiptLite[];
  const live = new Map<string, ReceiptLite>();
  const voided = new Map<string, ReceiptLite[]>();
  for (const r of receipts) {
    if (r.voided_at) voided.set(r.payment_id, [...(voided.get(r.payment_id) ?? []), r]);
    else live.set(r.payment_id, r);
  }
  const owed = payments.filter((p) => p.status === "pending" && (p.booking_status ?? "booked") !== "cancelled");
  const rest = payments.filter((p) => !owed.includes(p));

  const Row = ({ p }: { p: PaymentRow }) => {
    const r = live.get(p.id);
    const old = voided.get(p.id) ?? [];
    const status = p.status === "confirmed" ? "Paid" : paymentLabel(p.status) || p.status;
    const when = p.status === "confirmed" ? (r?.paid_on ?? p.confirmed_at?.slice(0, 10) ?? "") : p.created_at.slice(0, 10);
    return (
      <div className={`txrow ${p.status === "cancelled" ? "voided" : ""}`}>
        <div className="muted small">{when ? shortDate(new Date(when)) : "—"}</div>
        <div style={{ minWidth: 0 }}>
          <div><b>{describePayment(p)}</b>{p.code && <> <span className="tag code">{p.code}</span></>}</div>
          <div className="muted small">
            {status}
            {r ? ` · ${paidWith(r)} · receipt ${r.number}` : p.status === "confirmed" ? " · receipt on its way" : ""}
            {Number(p.credited_sek ?? 0) > 0 ? ` · cancelled — ${credits(Number(p.credited_sek))} back as credits` : ""}
            {old.length > 0 ? ` · earlier receipt ${old.map((v) => v.number).join(", ")} void` : ""}
          </div>
        </div>
        <div className="amt">{kr(Number(p.amount_sek) + Number(p.credit_sek ?? 0))}</div>
        <div className="actions">
          {r && <Link href={`/receipt/${r.id}`} className="btn line sm">Receipt</Link>}
          {p.status === "pending" && p.kind === "seat" && p.ref_id && <Link href={`/pay/${p.ref_id}?from=me`} className="btn red sm">Pay</Link>}
          {p.status === "pending" && p.kind === "material" && p.order_id && <Link href={`/store/orders/${p.order_id}`} className="btn red sm">Pay</Link>}
        </div>
      </div>
    );
  };

  return (
    <main className="page">
      {head}
      <div className="stack" style={{ gap: 16 }}>
        <Notice error={error} ok={ok} />
        <div className="muted small"><Link href="/me" style={{ fontWeight: 600 }}>← My seats</Link></div>
        <div className="muted small">Every seat, pass and Store order you have paid gets a receipt (kvitto) the moment the treasurer sees the money in the bank — or at once when credits covered it. Open one to see it or save the PDF.</div>
        {owed.length > 0 && (
          <section className="card stack paysect" style={{ padding: 18 }}>
            <h2>To pay</h2>
            <div className="stack" style={{ gap: 0 }}>{owed.map((p) => <Row key={p.id} p={p} />)}</div>
          </section>
        )}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>History</h2>
          {rest.length === 0 && <div className="muted small">Nothing yet.</div>}
          <div className="stack" style={{ gap: 0 }}>{rest.map((p) => <Row key={p.id} p={p} />)}</div>
        </section>
      </div>
    </main>
  );
}
