import Link from "next/link";
import { shortDate } from "@/lib/dates";
import { kr } from "@/lib/payments";
import { ORDER_STATUS_LABEL, REQUEST_STATUS_LABEL, productLabel, type Product, type RequestRow } from "@/lib/store";
import { decideRequest, quoteRequest } from "@/app/actions";

/**
 * Members' requests for things that are not on the list. Three answers:
 *  - Quote: "we can buy this for you for X kr" → a hidden item + an order the member pays → group order → ready
 *  - Added: you put it on the list as a product → link it, the member orders it in the Store
 *  - Decline, with a short reply
 */
export function RequestsSection({ requests, products, krwPerSek }: { requests: RequestRow[]; products: Product[]; krwPerSek: number }) {
  const open = requests.filter((r) => r.status === "open");
  const done = requests.filter((r) => r.status !== "open");
  return (
    <section className="card stack paysect" style={{ padding: 18 }}>
      <h2>Requests <span className={`count ${open.length === 0 ? "zero" : ""}`}>{open.length}</span></h2>
      <div className="muted small">
        <b>Quote</b> when it is a one-off: name it and set the price (₩{krwPerSek.toLocaleString("en-GB")} = 1 kr — type the cost in won and the price follows the rule, or type the price yourself). The member gets an order to pay; once paid it goes on the group order like any other line.
        <b> Added</b> when you have put it on the list as a product for everyone. <b>Decline</b> with a short reply.
      </div>
      {open.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>No open requests.</div>}
      {open.map((r) => (
        <div key={r.id} className="stack" style={{ gap: 8, paddingTop: 10, borderTop: "1px solid var(--divider)" }}>
          <div><b>{r.member_name}</b> <span className="muted small">· {shortDate(new Date(r.created_at))}</span></div>
          <div className="prewrap">{r.text}</div>
          <form action={quoteRequest} className="quote">
            <input type="hidden" name="request_id" value={r.id} />
            <input name="name" placeholder="item name for the order" defaultValue={r.text.length <= 60 ? r.text : ""} required aria-label="Item name" />
            <input name="qty" type="number" min={1} step={1} defaultValue={1} aria-label="Quantity" title="Quantity" />
            <input name="cost_krw" type="text" inputMode="numeric" placeholder="cost ₩" aria-label="Cost in won" title="Cost per piece in won (optional)" />
            <input name="price_sek" type="text" inputMode="numeric" placeholder="price kr (blank = from cost)" aria-label="Price in kronor" title="Price per piece in kronor — leave blank to use the rule on the cost" />
            <input name="reply" placeholder="reply (optional)" aria-label="Reply" />
            <button className="btn ink sm">Quote</button>
          </form>
          <form action={decideRequest} className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input type="hidden" name="request_id" value={r.id} />
            <select name="product_id" className="inline" defaultValue="" aria-label="Product added for this request">
              <option value="">— or: which product did you add? —</option>
              {products.filter((p) => p.category !== "Special").map((p) => <option key={p.id} value={p.id}>{productLabel(p)}{p.active ? "" : " (hidden)"}</option>)}
            </select>
            <input name="reply" placeholder="reply (optional)" style={{ flex: "1 1 160px", minHeight: 40, padding: "6px 10px", fontSize: 14 }} />
            <button className="btn line sm" name="status" value="added">Added</button>
            <button className="btn quiet sm" name="status" value="declined">Decline</button>
          </form>
        </div>
      ))}
      {done.length > 0 && (
        <details>
          <summary className="muted small" style={{ cursor: "pointer" }}>Answered requests ({done.length})</summary>
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>
            {done.map((r) => (
              <div key={r.id} className="txrow" style={{ gridTemplateColumns: "44px minmax(0, 1fr) auto" }}>
                <div className="muted small">{shortDate(new Date(r.created_at))}</div>
                <div style={{ minWidth: 0 }}>
                  <b>{r.member_name}</b> <span className="muted small">· {r.text}</span>
                  {r.status === "quoted" && (
                    <div className="muted small">
                      Quoted {kr(r.quote_sek)}{r.order_status ? ` · order: ${ORDER_STATUS_LABEL[r.order_status]}` : ""}
                      {r.order_id && <> · <Link href={`/store/orders/${r.order_id}`} style={{ fontWeight: 600 }}>Order</Link></>}
                    </div>
                  )}
                  {r.status === "added" && r.product_name ? <div className="muted small">→ {productLabel({ name: r.product_name, variant: r.product_variant, maker: r.product_maker })}</div> : null}
                  {r.reply ? <div className="muted small">&ldquo;{r.reply}&rdquo;</div> : null}
                </div>
                <div className="actions" style={{ gridColumn: "auto" }}>
                  <span className={`tag ${r.status === "added" ? "paid" : r.status === "quoted" ? "pending" : "unpaid"}`}>{REQUEST_STATUS_LABEL[r.status]}</span>
                  {(r.status !== "quoted" || r.payment_status !== "confirmed") && (
                    <form action={decideRequest}><input type="hidden" name="request_id" value={r.id} /><button className="btn quiet sm" name="status" value="open" title={r.status === "quoted" ? "Cancels the unpaid order and opens the request again" : "Back to open"}>Reopen</button></form>
                  )}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
