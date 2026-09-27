import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { shortDate } from "@/lib/dates";
import { kr } from "@/lib/payments";
import { ORDER_STATUS_LABEL, REQUEST_STATUS_LABEL, orderClass, orderTitle, productLabel, type OrderRow, type RequestRow } from "@/lib/store";
import { cancelOrder } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";

export default async function MyOrdersPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data }, { data: reqRows }] = await Promise.all([
    supabase.from("orders_view").select("*").eq("member_id", me.id).order("created_at", { ascending: false }).limit(50),
    supabase.from("requests_view").select("*").eq("member_id", me.id).order("created_at", { ascending: false }).limit(20),
  ]);
  const orders = (data ?? []) as OrderRow[];
  const requests = (reqRows ?? []) as RequestRow[];
  const open = orders.filter((o) => o.status === "awaiting_payment" || o.status === "in_progress" || o.status === "ready");
  const done = orders.filter((o) => !open.includes(o));

  const card = (o: OrderRow) => (
    <div key={o.id} className={`card stack person ${orderClass(o.status)}`} style={{ gap: 10, alignItems: "stretch", flexDirection: "column" }}>
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="bold">{orderTitle(o)} <span className="muted small">· {shortDate(new Date(o.created_at))}</span></div>
          <div className="muted small">{o.items_summary}</div>
        </div>
        <span className={`tag ${orderClass(o.status) || "unpaid"}`}>{ORDER_STATUS_LABEL[o.status]}</span>
      </div>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <span className="bold">{kr(o.total_sek)}</span>
        {o.status === "awaiting_payment" && o.payment_status === "pending" && <Link href={`/store/orders/${o.id}`} className="btn red sm">Pay {kr(o.total_sek)}</Link>}
        {(o.status !== "awaiting_payment" || o.payment_status !== "pending") && <Link href={`/store/orders/${o.id}`} className="btn line sm">Details</Link>}
        {o.status === "awaiting_payment" && (
          <form action={cancelOrder} className="grow" style={{ display: "flex", justifyContent: "flex-end" }}>
            <input type="hidden" name="order_id" value={o.id} />
            <input type="hidden" name="back" value="/store/orders" />
            <button className="btn quiet sm">Cancel</button>
          </form>
        )}
      </div>
    </div>
  );

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>My orders</h1><div className="muted small">{me.name}</div></div>
        <TopNav current="store" me={me} />
      </div>
      <div className="stack">
        <Notice error={error} ok={ok} />
        <Link href="/store" className="btn line sm" style={{ alignSelf: "flex-start" }}>← Back to the Store</Link>
        {orders.length === 0 && <div className="card dashed" style={{ padding: 24, textAlign: "center" }}>No orders yet. <Link href="/store" style={{ color: "var(--red)", fontWeight: 600 }}>Browse the Store</Link>.</div>}
        {open.map(card)}
        {done.length > 0 && <div className="muted small" style={{ marginTop: 8 }}>Earlier</div>}
        {done.map(card)}

        {requests.length > 0 && (
          <section className="stack" style={{ gap: 8, marginTop: 12 }}>
            <div className="bold">My requests</div>
            {requests.map((r) => (
              <div key={r.id} className="card stack" style={{ gap: 4 }}>
                <div className="row between" style={{ alignItems: "flex-start", gap: 8 }}>
                  <div className="prewrap" style={{ minWidth: 0 }}>{r.text}</div>
                  <span className={`tag ${r.status === "added" || r.status === "quoted" ? "paid" : r.status === "open" ? "pending" : "unpaid"}`}>{REQUEST_STATUS_LABEL[r.status]}</span>
                </div>
                <div className="muted small">{shortDate(new Date(r.created_at))}{r.reply ? ` · ${r.reply}` : ""}</div>
                {r.status === "quoted" && r.order_id && (
                  <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                    <span className="small">We can buy it for you for <b>{kr(r.quote_sek)}</b>{r.order_status ? ` · ${ORDER_STATUS_LABEL[r.order_status]}` : ""}</span>
                    <Link href={`/store/orders/${r.order_id}`} className={`btn sm ${r.order_status === "awaiting_payment" && r.payment_status === "pending" ? "red" : "line"}`}>
                      {r.order_status === "awaiting_payment" && r.payment_status === "pending" ? `Pay ${kr(r.quote_sek)}` : "Order"}
                    </Link>
                  </div>
                )}
                {r.status === "added" && r.product_name && (
                  <div className="small">Now on the list: <Link href="/store" style={{ fontWeight: 600, color: "var(--red)" }}>{productLabel({ name: r.product_name, variant: r.product_variant, maker: r.product_maker })}</Link>{r.product_active ? "" : " (not on the list right now)"}</div>
                )}
              </div>
            ))}
          </section>
        )}
      </div>
    </main>
  );
}
