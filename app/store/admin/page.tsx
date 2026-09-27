import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { shortDate } from "@/lib/dates";
import { kr } from "@/lib/payments";
import { CATEGORY_ORDER, groupProducts, productLabel, stockLevel, type OrderItem, type OrderRow, type Product } from "@/lib/store";
import { addProduct, adjustStock, fulfilFromStock, markCollected, saveProduct } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";

type Line = OrderItem & {
  product: { id: string; code: string; stock: number } | null;
  order: { id: string; created_at: string; note: string | null; member: { name: string } | null; payment: { code: string | null; status: string; confirmed_at: string | null } | null } | null;
};
type Movement = { id: string; qty: number; kind: string; note: string | null; created_at: string; product: { name: string; variant: string | null; code: string } | null };

export default async function StoreAdminPage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/store");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: lineRows }, { data: waitingRows }, { data: productRows }, { data: moveRows }] = await Promise.all([
    supabase.from("order_items").select("*, product:products(id, code, stock), order:orders(id, created_at, note, member:members(name), payment:payments(code, status, confirmed_at))").in("status", ["paid", "ready"]).order("updated_at"),
    supabase.from("orders_view").select("*").eq("status", "awaiting_payment").order("created_at", { ascending: false }),
    supabase.from("products").select("*").order("sort").order("name"),
    supabase.from("stock_movements").select("id, qty, kind, note, created_at, product:products(name, variant, code)").order("created_at", { ascending: false }).limit(20),
  ]);
  const lines = (lineRows ?? []) as unknown as Line[];
  const waiting = (waitingRows ?? []) as OrderRow[];
  const products = (productRows ?? []) as Product[];
  const moves = (moveRows ?? []) as unknown as Movement[];
  const groups = groupProducts(products);

  // lines grouped by order, oldest order first
  const byOrder = new Map<string, Line[]>();
  for (const l of lines) byOrder.set(l.order_id, [...(byOrder.get(l.order_id) ?? []), l]);
  const orderBlocks = [...byOrder.values()].sort((a, b) => (a[0].order?.created_at ?? "").localeCompare(b[0].order?.created_at ?? ""));
  const lowCount = products.filter((p) => p.active && stockLevel(p) !== "ok").length;

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Store · Manage</h1><div className="muted small">Products, stock and orders · Treasurer and Admin</div></div>
        <TopNav current="store" me={me} />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Notice error={error} ok={ok} />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Link href="/store" className="btn line sm">Store (member view)</Link>
          <Link href="/payments" className="btn line sm">Payments</Link>
          <span className="muted small" style={{ marginLeft: "auto" }}>{lowCount} product{lowCount === 1 ? "" : "s"} low or out of stock</span>
        </div>

        {/* 1. paid orders to hand out */}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>To hand out <span className={`count ${lines.length === 0 ? "zero" : ""}`}>{lines.filter((l) => l.status === "paid").length}</span></h2>
          <div className="muted small">Paid lines. &ldquo;From stock&rdquo; takes the items off the shelf and tells the member they are ready; tick &ldquo;Collected&rdquo; when they pick up. Lines with no stock wait for the next group order (coming in step 2b).</div>
          {orderBlocks.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>Nothing to hand out.</div>}
          {orderBlocks.map((ls) => {
            const o = ls[0].order;
            return (
              <div key={ls[0].order_id} className="stack" style={{ gap: 6, paddingTop: 8, borderTop: "1px solid var(--divider)" }}>
                <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
                  <div><b>{o?.member?.name ?? "Member"}</b> <span className="muted small">· {o?.payment?.code} · ordered {o ? shortDate(new Date(o.created_at)) : ""}{o?.payment?.confirmed_at ? ` · paid ${shortDate(new Date(o.payment.confirmed_at))}` : ""}</span></div>
                  <Link href={`/store/orders/${ls[0].order_id}`} className="muted small">Details</Link>
                </div>
                {o?.note && <div className="muted small">Note: {o.note}</div>}
                {ls.map((l) => {
                  const stock = l.product?.stock ?? 0;
                  const enough = stock >= l.qty;
                  return (
                    <div key={l.id} className="txrow" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", borderTop: 0, padding: "4px 0" }}>
                      <div style={{ minWidth: 0 }}>
                        <span className="bold">{l.qty}× {l.name}</span>
                        <span className="muted small"> · {kr(l.qty * l.unit_price_sek)} · {stock} in stock</span>
                        {l.status === "ready" && <span className="tag paid" style={{ marginLeft: 8 }}>ready to collect</span>}
                      </div>
                      <div className="actions" style={{ gridColumn: "auto" }}>
                        {l.status === "paid" && enough && (
                          <form action={fulfilFromStock}><input type="hidden" name="item_id" value={l.id} /><button className="btn ink sm">From stock → ready</button></form>
                        )}
                        {l.status === "paid" && !enough && <span className="tag pending">only {stock} in stock · next group order</span>}
                        {l.status === "ready" && (
                          <form action={markCollected}><input type="hidden" name="item_id" value={l.id} /><button className="btn line sm">Collected</button></form>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </section>

        {/* 2. awaiting payment */}
        <details className="card paysect" style={{ padding: 18 }}>
          <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Awaiting payment <span className={`count ${waiting.length === 0 ? "zero" : ""}`}>{waiting.length}</span></h2><span className="muted small" style={{ marginLeft: 10 }}>confirmed in <Link href="/payments" style={{ fontWeight: 600 }}>Payments</Link></span></summary>
          <div className="stack" style={{ marginTop: 12 }}>
            {waiting.length === 0 && <div className="muted small">No open orders.</div>}
            {waiting.map((o) => (
              <div key={o.id} className="txrow">
                <div className="muted small">{shortDate(new Date(o.created_at))}</div>
                <div style={{ minWidth: 0 }}><b>{o.member_name}</b> <span className="tag code">{o.code}</span><span className="muted small"> · {o.items_summary}{o.payment_status === "claimed" ? " · says they have paid" : ""}</span></div>
                <div className="amt">{kr(o.total_sek)}</div>
                <div className="actions"><Link href={`/store/orders/${o.id}`} className="btn quiet sm">Details</Link></div>
              </div>
            ))}
          </div>
        </details>

        {/* 3. products */}
        <section className="card stack paysect" style={{ padding: 18 }}>
          <h2>Products <span className="count">{products.length}</span></h2>
          <div className="muted small">Stock changes only through &ldquo;Adjust&rdquo; (+ in, − out) so every change is on record. Untick &ldquo;On the list&rdquo; to hide a product from members. Low = at or below the minimum.</div>
          {groups.map((g) => (
            <div key={g.category} className="stack" style={{ gap: 4 }}>
              <div className="sublabel" style={{ fontSize: 15, color: "var(--ink)" }}>{g.category}</div>
              {g.groups.map((sg) => sg.items.map((p) => {
                const lvl = stockLevel(p);
                return (
                  <div key={p.id} className={`padmin ${p.active ? "" : "off"}`}>
                    <form action={saveProduct} className="pedit">
                      <input type="hidden" name="product_id" value={p.id} />
                      <input type="hidden" name="category" value={p.category} />
                      <div className="muted small" style={{ gridColumn: "1 / -1" }}>{p.code} · {sg.subcategory}</div>
                      <input name="name" defaultValue={p.name} aria-label="Name" required />
                      <input name="variant" defaultValue={p.variant ?? ""} placeholder="variant" aria-label="Variant" />
                      <input name="maker" defaultValue={p.maker ?? ""} placeholder="maker" aria-label="Maker" />
                      <input name="subcategory" defaultValue={p.subcategory ?? ""} placeholder="subcategory" aria-label="Subcategory" />
                      <label className="fld">kr<input name="price_sek" type="number" min={0} step={1} defaultValue={p.price_sek} aria-label="Price" /></label>
                      <label className="fld">min<input name="min_stock" type="number" min={0} step={1} defaultValue={p.min_stock} aria-label="Minimum stock" /></label>
                      <label className="check"><input type="checkbox" name="active" defaultChecked={p.active} /> On the list</label>
                      <button className="btn line sm">Save</button>
                    </form>
                    <form action={adjustStock} className="pstock">
                      <input type="hidden" name="product_id" value={p.id} />
                      <span className={`tag ${lvl === "ok" ? "paid" : lvl === "low" ? "pending" : "unpaid"}`} style={{ marginLeft: 0 }}>{p.stock} in stock{lvl === "low" ? " · low" : lvl === "out" ? " · out" : ""}</span>
                      <input name="qty" type="number" step={1} placeholder="+/−" aria-label="Change stock by" className="qty" />
                      <input name="note" placeholder="why (optional)" aria-label="Reason" />
                      <button className="btn quiet sm">Adjust</button>
                    </form>
                  </div>
                );
              }))}
            </div>
          ))}
        </section>

        {/* 4. add a product */}
        <details className="card paysect" style={{ padding: 18 }}>
          <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Add a product</h2></summary>
          <form action={addProduct} className="stack" style={{ marginTop: 12 }}>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div className="grow"><label htmlFor="np_name">Name</label><input id="np_name" name="name" required placeholder="Colour brush 채화" /></div>
              <div><label htmlFor="np_variant">Variant</label><input id="np_variant" name="variant" placeholder="중 (M)" /></div>
              <div><label htmlFor="np_maker">Maker</label><input id="np_maker" name="maker" placeholder="구하산방" /></div>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div><label htmlFor="np_cat">Category</label>
                <select id="np_cat" name="category" defaultValue="Brush">{CATEGORY_ORDER.map((c) => <option key={c} value={c}>{c}</option>)}<option value="Other">Other</option></select>
              </div>
              <div><label htmlFor="np_sub">Subcategory</label><input id="np_sub" name="subcategory" placeholder="Colour brush" /></div>
              <div><label htmlFor="np_code">Code <span style={{ opacity: 0.7 }}>(optional, unique)</span></label><input id="np_code" name="code" placeholder="ColourBrush-채화-중-구하산방" /></div>
            </div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div><label htmlFor="np_price">Price (kr)</label><input id="np_price" name="price_sek" type="number" min={0} step={1} required /></div>
              <div><label htmlFor="np_min">Minimum stock</label><input id="np_min" name="min_stock" type="number" min={0} step={1} defaultValue={5} /></div>
              <div><label htmlFor="np_open">Stock now</label><input id="np_open" name="opening_stock" type="number" min={0} step={1} defaultValue={0} /></div>
            </div>
            <label className="check" style={{ alignSelf: "flex-start" }}><input type="checkbox" name="active" defaultChecked /> On the list</label>
            <button className="btn ink sm" style={{ alignSelf: "flex-start" }}>Add product</button>
          </form>
        </details>

        {/* 5. stock log */}
        <details className="card paysect" style={{ padding: 18 }}>
          <summary style={{ cursor: "pointer" }}><h2 style={{ display: "inline" }}>Recent stock changes</h2></summary>
          <div className="stack" style={{ marginTop: 12, gap: 0 }}>
            {moves.length === 0 && <div className="muted small">Nothing yet.</div>}
            {moves.map((m) => (
              <div key={m.id} className="txrow" style={{ gridTemplateColumns: "44px minmax(0, 1fr) 60px" }}>
                <div className="muted small">{shortDate(new Date(m.created_at))}</div>
                <div style={{ minWidth: 0 }}><b>{m.product ? productLabel({ name: m.product.name, variant: m.product.variant, maker: null }) : "—"}</b><span className="muted small"> · {m.kind}{m.note ? ` · ${m.note}` : ""}</span></div>
                <div className="amt" style={{ fontSize: 16 }}>{m.qty > 0 ? `+${m.qty}` : m.qty}</div>
              </div>
            ))}
          </div>
        </details>
      </div>
    </main>
  );
}
