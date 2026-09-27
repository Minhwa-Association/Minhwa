import Link from "next/link";
import { shortDate } from "@/lib/dates";
import { kr } from "@/lib/payments";
import { BATCH_STATUS_LABEL, batchCosts, defaultBatchName, krw, priceFromCost, type Batch, type PurchaseListRow } from "@/lib/store";
import { addAllWaitingToBatch, addLineToBatch, markBatchArrived, markBatchOrdered, refundLine, removeLineFromBatch, saveBatchCosts, setProductPrice, setRestock, startBatch, suggestRestock } from "@/app/actions";

export type WaitingLine = {
  id: string; order_id: string; qty: number; name: string; unit_price_sek: number; status: string; batch_id: string | null; updated_at: string;
  product: { id: string; code: string; stock: number } | null;
  order: { id: string; created_at: string; note: string | null; member: { name: string } | null; payment: { code: string | null; status: string; confirmed_at: string | null } | null } | null;
};

/** Group order from Korea: the active batch (open or ordered), its shopping list, costs; or the form to start one. */
export function GroupOrderSection({ batch, list, waiting, onBatch, past, krwPerSek }: {
  batch: Batch | null;                 // the open or ordered one
  list: PurchaseListRow[];             // purchase_list_view rows of that batch
  waiting: WaitingLine[];              // paid lines with too little stock, not on any batch
  onBatch: WaitingLine[];              // group_buy lines of that batch
  past: Batch[];                       // arrived batches
  krwPerSek: number;                   // the price rule: 1 kr per this many won
}) {
  const open = batch?.status === "open";
  const costs = batch ? batchCosts(batch) : null;
  const membersPaid = list.reduce((s, r) => s + Number(r.member_value_sek), 0);
  const restockValue = list.reduce((s, r) => s + Number(r.restock_qty) * Number(r.price_sek), 0);
  const pieces = list.reduce((s, r) => s + Number(r.total_qty), 0);
  // cost of the pieces on the list at the real rate, where a cost per piece is known
  const knownCostKrw = list.reduce((s, r) => s + (r.unit_cost_krw ? Number(r.unit_cost_krw) * Number(r.total_qty) : 0), 0);
  const logistics = batch ? Number(batch.shipping_sek) + Number(batch.customs_sek) + Number(batch.vat_sek) : 0;

  return (
    <section className="card stack paysect" style={{ padding: 18 }}>
      <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
        <h2>Group order from Korea{batch ? <> <span className="tag code" style={{ fontSize: 13 }}>{batch.name}</span> <span className={`tag ${batch.status === "ordered" ? "pending" : "paid"}`}>{BATCH_STATUS_LABEL[batch.status]}{batch.ordered_at ? ` ${shortDate(new Date(batch.ordered_at))}` : ""}</span></> : null}</h2>
        {batch && open && (
          <form action={markBatchOrdered}><input type="hidden" name="batch_id" value={batch.id} /><button className="btn ink sm">Mark as ordered</button></form>
        )}
        {batch && batch.status === "ordered" && (
          <form action={markBatchArrived}><input type="hidden" name="batch_id" value={batch.id} /><button className="btn ink sm">Arrived — book stock in</button></form>
        )}
      </div>

      {!batch && (
        <form action={startBatch} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div className="grow"><label htmlFor="batch_name">Name of the next group order</label><input id="batch_name" name="name" defaultValue={defaultBatchName()} required /></div>
          <button className="btn ink sm" style={{ minHeight: 48 }}>Start a group order</button>
        </form>
      )}
      <div className="muted small">
        Paid lines that cannot be handed out from stock go on the group order. Add restock for the shelf, then &ldquo;Mark as ordered&rdquo; when you have bought it in Korea and &ldquo;Arrived&rdquo; when the boxes are here — stock is booked in and members&apos; items become ready to collect.
      </div>

      {/* waiting lines */}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
          <div className="bold">Waiting for the group order <span className={`count ${waiting.length === 0 ? "zero" : ""}`}>{waiting.length}</span></div>
          {open && waiting.length > 1 && <form action={addAllWaitingToBatch}><button className="btn line sm">Put all {waiting.length} on the group order</button></form>}
        </div>
        {waiting.length === 0 && <div className="muted small">Nothing waiting — every paid line can be handed out from stock.</div>}
        {waiting.map((l) => (
          <div key={l.id} className="txrow" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", padding: "4px 0" }}>
            <div style={{ minWidth: 0 }}>
              <b>{l.order?.member?.name ?? "Member"}</b> <span className="muted small">· {l.order?.payment?.code} · {l.order ? shortDate(new Date(l.order.created_at)) : ""}</span>
              <div>{l.qty}× {l.name} <span className="muted small">· {kr(l.qty * l.unit_price_sek)} · {l.product?.stock ?? 0} in stock</span></div>
            </div>
            <div className="actions" style={{ gridColumn: "auto" }}>
              {open ? (
                <form action={addLineToBatch}><input type="hidden" name="item_id" value={l.id} /><button className="btn ink sm">Put on group order</button></form>
              ) : <span className="muted small">{batch ? "next group order" : "start a group order"}</span>}
              <form action={refundLine}><input type="hidden" name="item_id" value={l.id} /><button className="btn quiet sm" title="Tick after you have sent the money back with Swish">Refunded via Swish</button></form>
            </div>
          </div>
        ))}
      </div>

      {batch && (
        <>
          {/* shopping list */}
          <div className="stack" style={{ gap: 6 }}>
            <div className="row between" style={{ flexWrap: "wrap", gap: 6 }}>
              <div className="bold">Shopping list <span className="muted small">· {pieces} piece{pieces === 1 ? "" : "s"} · members paid {kr(membersPaid)} · restock worth {kr(restockValue)} at sale price</span></div>
              {open && <form action={suggestRestock}><input type="hidden" name="batch_id" value={batch.id} /><button className="btn line sm">Add restock for low-stock products</button></form>}
            </div>
            {list.length === 0 && <div className="muted small">Empty — put waiting lines on it or add restock.</div>}
            {list.length > 0 && (
              <div className="shoplist">
                <div className="shophead"><span>Product</span><span>Members</span><span>Restock</span><span>Total</span><span>Cost / pc (₩)</span><span>Price (kr)</span><span /></div>
                {list.map((r) => (
                  <form key={r.product_id} action={setRestock} className="shoprow">
                    <input type="hidden" name="batch_id" value={batch.id} />
                    <input type="hidden" name="product_id" value={r.product_id} />
                    <span style={{ minWidth: 0 }}><b>{r.name}</b>{(r.variant || r.maker) && <span className="muted small"> · {[r.variant, r.maker].filter(Boolean).join(" · ")}</span>}<span className="muted small"> · {r.stock} in stock</span></span>
                    <span>{r.member_qty > 0 ? <>{r.member_qty} <span className="muted small">({r.orders} order{r.orders === 1 ? "" : "s"}{r.waiting_qty !== r.member_qty && batch.status !== "arrived" ? "" : ""})</span></> : <span className="muted">—</span>}</span>
                    <span>{open ? <input name="restock_qty" type="number" min={0} step={1} defaultValue={r.restock_qty} className="qty" aria-label="Restock pieces" /> : <span>{r.restock_qty}</span>}</span>
                    <span className="bold">{r.total_qty}</span>
                    <span>{open ? <input name="unit_cost_krw" type="text" inputMode="numeric" defaultValue={r.unit_cost_krw ?? ""} placeholder="₩" className="qty" style={{ width: 84 }} aria-label="Cost per piece in KRW" /> : <span>{r.unit_cost_krw ? krw(r.unit_cost_krw) : "—"}</span>}</span>
                    <span className="small">
                      {r.price_sek} kr
                      {(() => { const sug = priceFromCost(r.unit_cost_krw, krwPerSek); return sug !== null && sug !== Number(r.price_sek) ? <span className="muted"> → rule {sug} kr</span> : null; })()}
                    </span>
                    <span>{open && <button className="btn line sm">Set</button>}</span>
                  </form>
                ))}
                {list.some((r) => { const sug = priceFromCost(r.unit_cost_krw, krwPerSek); return sug !== null && sug !== Number(r.price_sek); }) && (
                  <div className="stack" style={{ gap: 4, paddingTop: 8 }}>
                    <div className="muted small">Prices that differ from the rule (₩{krwPerSek.toLocaleString("en-GB")} = 1 kr) — set them when you are sure of the cost:</div>
                    {list.filter((r) => { const sug = priceFromCost(r.unit_cost_krw, krwPerSek); return sug !== null && sug !== Number(r.price_sek); }).map((r) => {
                      const sug = priceFromCost(r.unit_cost_krw, krwPerSek)!;
                      return (
                        <form key={`price-${r.product_id}`} action={setProductPrice} className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                          <input type="hidden" name="product_id" value={r.product_id} />
                          <input type="hidden" name="price_sek" value={sug} />
                          <input type="hidden" name="cost_krw" value={String(r.unit_cost_krw ?? "")} />
                          <span className="small" style={{ minWidth: 0 }}><b>{r.name}</b>{r.variant ? ` · ${r.variant}` : ""}: {r.price_sek} kr → <b>{sug} kr</b> <span className="muted">({krw(r.unit_cost_krw)})</span></span>
                          <button className="btn line sm">Set price {sug} kr</button>
                        </form>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* members' lines on the batch */}
          <div className="stack" style={{ gap: 6 }}>
            <div className="bold">Members&apos; lines on this order <span className={`count ${onBatch.length === 0 ? "zero" : ""}`}>{onBatch.length}</span></div>
            {onBatch.map((l) => (
              <div key={l.id} className="txrow" style={{ gridTemplateColumns: "minmax(0, 1fr) auto", padding: "4px 0" }}>
                <div style={{ minWidth: 0 }}><b>{l.order?.member?.name ?? "Member"}</b> <span className="muted small">· {l.order?.payment?.code}</span> · {l.qty}× {l.name} <span className="muted small">· {kr(l.qty * l.unit_price_sek)}</span></div>
                <div className="actions" style={{ gridColumn: "auto" }}>
                  {open && <form action={removeLineFromBatch}><input type="hidden" name="item_id" value={l.id} /><button className="btn quiet sm">Take off</button></form>}
                  <form action={refundLine}><input type="hidden" name="item_id" value={l.id} /><button className="btn quiet sm" title="Tick after you have sent the money back with Swish">Refunded via Swish</button></form>
                </div>
              </div>
            ))}
          </div>

          {/* costs */}
          <form action={saveBatchCosts} className="stack" style={{ gap: 8 }}>
            <input type="hidden" name="batch_id" value={batch.id} />
            <div className="bold">Costs</div>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              <div><label htmlFor="cost_krw">Goods (KRW)</label><input id="cost_krw" name="cost_krw" type="text" inputMode="numeric" defaultValue={Number(batch.cost_krw) || ""} placeholder="1 500 000" style={{ width: 150 }} /></div>
              <div><label htmlFor="fx">SEK per KRW</label><input id="fx" name="fx_sek_per_krw" type="text" inputMode="decimal" defaultValue={batch.fx_sek_per_krw ?? ""} placeholder="0.0072" style={{ width: 110 }} /></div>
              <div><label htmlFor="ship">Shipping (kr)</label><input id="ship" name="shipping_sek" type="number" min={0} step={1} defaultValue={batch.shipping_sek || ""} style={{ width: 110 }} /></div>
              <div><label htmlFor="cust">Customs (kr)</label><input id="cust" name="customs_sek" type="number" min={0} step={1} defaultValue={batch.customs_sek || ""} style={{ width: 110 }} /></div>
              <div><label htmlFor="vat">Import VAT (kr)</label><input id="vat" name="vat_sek" type="number" min={0} step={1} defaultValue={batch.vat_sek || ""} style={{ width: 110 }} /></div>
              <div className="grow"><label htmlFor="bnotes">Notes</label><input id="bnotes" name="notes" defaultValue={batch.notes ?? ""} placeholder="DHL, 2 boxes…" /></div>
            </div>
            <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <button className="btn line sm">Save costs</button>
            </div>
            {costs && (
              <div className="muted small stack" style={{ gap: 2 }}>
                <div>Members are not charged shipping, customs or VAT — they pay by the rule (₩{krwPerSek.toLocaleString("en-GB")} = 1 kr) and the gap to the real rate has to cover them.</div>
                <div>
                  Goods at the real rate <b>{kr(costs.goods)}</b>{knownCostKrw > 0 && batch.fx_sek_per_krw ? <span> (the list&apos;s known costs: {krw(knownCostKrw)} ≈ {kr(Math.round(knownCostKrw * Number(batch.fx_sek_per_krw)))})</span> : null} · shipping + customs + VAT <b>{kr(logistics)}</b> · total <b>{kr(costs.total)}</b>
                </div>
                <div>
                  Members paid <b>{kr(membersPaid)}</b> · restock worth {kr(restockValue)} at members&apos; prices → if everything is sold the gap is{" "}
                  <b style={{ color: membersPaid + restockValue - costs.total < 0 ? "var(--red)" : "var(--green-text)" }}>{kr(membersPaid + restockValue - costs.total)}</b>
                  {costs.goods > 0 ? <span> (margin over goods {kr(membersPaid + restockValue - costs.goods)} vs logistics {kr(logistics)})</span> : null}
                </div>
              </div>
            )}
          </form>
        </>
      )}

      {past.length > 0 && (
        <details>
          <summary className="muted small" style={{ cursor: "pointer" }}>Earlier group orders ({past.length})</summary>
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>
            {past.map((b) => {
              const c = batchCosts(b);
              return (
                <div key={b.id} className="txrow" style={{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                  <div><b>{b.name}</b> <span className="muted small">· ordered {b.ordered_at ? shortDate(new Date(b.ordered_at)) : "—"} · arrived {b.arrived_at ? shortDate(new Date(b.arrived_at)) : "—"}{b.notes ? ` · ${b.notes}` : ""}</span></div>
                  <div className="muted small">cost {kr(c.total)}</div>
                </div>
              );
            })}
          </div>
        </details>
      )}
      <div className="muted small">Prices are fixed in kronor by the rule (₩{krwPerSek.toLocaleString("en-GB")} = 1 kr); after a group order check them above or in <Link href="#products" style={{ fontWeight: 600 }}>Products</Link>. The rule itself is in Admin → Settings.</div>
    </section>
  );
}
