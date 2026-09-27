import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { longDate } from "@/lib/dates";
import { kr } from "@/lib/payments";
import { formatSwishNumber, swishUrl } from "@/lib/swish";
import { LINE_STATUS_LABEL, ORDER_STATUS_LABEL, orderTitle, type BatchPublic, type OrderItem, type OrderRow } from "@/lib/store";
import { shortDate } from "@/lib/dates";
import { cancelOrder, claimPayment } from "@/app/actions";
import { Chevron, Notice } from "@/app/components";

export default async function OrderPage({ params, searchParams }: { params: Promise<{ orderId: string }>; searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { orderId } = await params;
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: order }, { data: items }, { data: settings }] = await Promise.all([
    supabase.from("orders_view").select("*").eq("id", orderId).maybeSingle(),
    supabase.from("order_items").select("*").eq("order_id", orderId).order("name"),
    supabase.from("settings").select("swish_number, swish_payee_name").eq("id", 1).single(),
  ]);
  const o = order as OrderRow | null;
  if (!o) notFound();
  const mine = o.member_id === me.id;
  if (!mine && !canUsePayments(me)) notFound();
  const lines = (items ?? []) as OrderItem[];
  const batchIds = [...new Set(lines.map((l) => l.batch_id).filter((x): x is string => !!x))];
  const [{ data: payment }, { data: batchRows }] = await Promise.all([
    o.payment_id
      ? supabase.from("payments").select("id, code, note, amount_sek, status").eq("id", o.payment_id).single()
      : Promise.resolve({ data: null }),
    batchIds.length
      ? supabase.from("group_orders_public").select("*").in("id", batchIds)
      : Promise.resolve({ data: [] as BatchPublic[] }),
  ]);
  const batchById = new Map(((batchRows ?? []) as BatchPublic[]).map((b) => [b.id, b]));
  const lineStatus = (l: OrderItem) => {
    if (l.status === "group_buy" && l.batch_id && batchById.get(l.batch_id)) {
      const b = batchById.get(l.batch_id)!;
      return `${LINE_STATUS_LABEL[l.status]} · ${b.name}${b.status === "ordered" && b.ordered_at ? ` · ordered ${shortDate(new Date(b.ordered_at))}, on its way` : ""}`;
    }
    return LINE_STATUS_LABEL[l.status];
  };

  const payee = settings?.swish_number ?? "";
  const message = payment?.note ?? `${o.code ?? ""} Store ${o.member_name}`.trim();
  const link = swishUrl({ payee, amountSek: Number(o.total_sek ?? 0), message });
  const unpaid = o.status === "awaiting_payment";
  const pending = o.payment_status === "pending";
  const claimed = o.payment_status === "claimed";
  const here = `/store/orders/${o.id}`;

  const headline = o.status === "awaiting_payment" ? (claimed ? "Awaiting confirmation" : "Order placed") : ORDER_STATUS_LABEL[o.status];
  const sub = o.status === "awaiting_payment"
    ? (claimed ? "The treasurer confirms your Swish payment when it shows up in the bank, then prepares your items." : "Pay with Swish to finish — the total and a payment code are pre-filled.")
    : o.status === "in_progress" ? "Paid. Items in stock are handed out at the studio; the rest come with the next group order from Korea."
    : o.status === "ready" ? "Ready — collect it at your next visit to the studio."
    : o.status === "collected" ? "All collected. Thank you."
    : o.status === "cancelled" ? "This order was cancelled." : "This order was refunded.";

  return (
    <main className="page">
      <div style={{ paddingTop: 20 }} className="stack">
        <Link href={mine ? "/store/orders" : "/store/admin"} className="row muted" style={{ minHeight: 44, fontWeight: 500 }}><Chevron dir="left" /> {mine ? "My orders" : "Manage store"}</Link>
        <div>
          <h1 style={{ fontSize: 32 }}>{headline}</h1>
          <div className="muted">{sub}</div>
        </div>
        <Notice error={error} ok={ok} />

        <div className="card stack" style={{ gap: 12, padding: 18 }}>
          <div className="kv"><span className="k">{orderTitle(o)}</span><span className="v">{longDate(new Date(o.created_at))}</span></div>
          {!mine && <div className="kv"><span className="k">Member</span><span className="v">{o.member_name}</span></div>}
          <div className="divider" />
          {lines.map((l) => (
            <div key={l.id} className="kv" style={{ alignItems: "flex-start" }}>
              <span className="k" style={{ color: "var(--ink)" }}>{l.qty}× {l.name}<br /><span className="muted small">{lineStatus(l)}</span></span>
              <span className="v">{kr(l.qty * l.unit_price_sek)}</span>
            </div>
          ))}
          {o.note && <div className="muted small">Note: {o.note}</div>}
          <div className="divider" />
          <div className="kv"><span className="k">Total</span><span className="amount">{kr(o.total_sek)}</span></div>
          {o.code && <div className="kv"><span className="k">Payment code</span><span className="v"><span className="tag code">{o.code}</span></span></div>}
        </div>

        {unpaid && mine && (
          <div className="card stack" style={{ gap: 10, padding: "16px 18px" }}>
            <div className="muted small bold">Pre-filled in Swish</div>
            <div className="kv"><span className="k">To</span><span className="v">{settings?.swish_payee_name} · {formatSwishNumber(payee)}</span></div>
            <div className="kv"><span className="k">Message</span><span className="v">{message}</span></div>
            <div className="muted small">On a computer? Open Swish on your phone and send {kr(o.total_sek)} to {formatSwishNumber(payee)} with the message above — keep the code, it is how your payment is recognised.</div>
          </div>
        )}
      </div>

      <div className="footer">
        {unpaid && mine && (
          <>
            <a href={link} className="btn ink">Open Swish and pay</a>
            {pending && payment && (
              <form action={claimPayment}>
                <input type="hidden" name="payment_id" value={payment.id} />
                <input type="hidden" name="back" value={here} />
                <button className="btn line">I have paid</button>
              </form>
            )}
            <form action={cancelOrder}>
              <input type="hidden" name="order_id" value={o.id} />
              <input type="hidden" name="back" value="/store/orders" />
              <button className="btn quiet">Cancel this order</button>
            </form>
          </>
        )}
        {(!unpaid || !mine) && <Link href={mine ? "/store" : "/store/admin"} className="btn ink">{mine ? "Back to the Store" : "Back to Manage store"}</Link>}
      </div>
    </main>
  );
}
