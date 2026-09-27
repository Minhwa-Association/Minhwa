import { shortDate } from "@/lib/dates";
import { REQUEST_STATUS_LABEL, productLabel, type Product, type RequestRow } from "@/lib/store";
import { decideRequest } from "@/app/actions";

/** Members' requests for things that are not on the list — link to a product you added, or decline. */
export function RequestsSection({ requests, products }: { requests: RequestRow[]; products: Product[] }) {
  const open = requests.filter((r) => r.status === "open");
  const done = requests.filter((r) => r.status !== "open");
  return (
    <section className="card stack paysect" style={{ padding: 18 }}>
      <h2>Requests <span className={`count ${open.length === 0 ? "zero" : ""}`}>{open.length}</span></h2>
      <div className="muted small">A member asked for something that is not on the list. Add it in &ldquo;Add a product&rdquo; below, then come back and link it here — the member sees &ldquo;Added to the Store&rdquo;. Or decline with a short reply.</div>
      {open.length === 0 && <div className="card dashed" style={{ padding: 16, textAlign: "center" }}>No open requests.</div>}
      {open.map((r) => (
        <form key={r.id} action={decideRequest} className="stack" style={{ gap: 6, paddingTop: 8, borderTop: "1px solid var(--divider)" }}>
          <input type="hidden" name="request_id" value={r.id} />
          <div><b>{r.member_name}</b> <span className="muted small">· {shortDate(new Date(r.created_at))}</span></div>
          <div className="prewrap">{r.text}</div>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <select name="product_id" className="inline" defaultValue="" aria-label="Product added for this request">
              <option value="">— which product did you add? —</option>
              {products.map((p) => <option key={p.id} value={p.id}>{productLabel(p)}{p.active ? "" : " (hidden)"}</option>)}
            </select>
            <input name="reply" placeholder="reply to the member (optional)" style={{ flex: "1 1 200px", minHeight: 40, padding: "6px 10px", fontSize: 14 }} />
            <button className="btn ink sm" name="status" value="added">Added</button>
            <button className="btn quiet sm" name="status" value="declined">Decline</button>
          </div>
        </form>
      ))}
      {done.length > 0 && (
        <details>
          <summary className="muted small" style={{ cursor: "pointer" }}>Answered requests ({done.length})</summary>
          <div className="stack" style={{ gap: 4, marginTop: 8 }}>
            {done.map((r) => (
              <div key={r.id} className="txrow" style={{ gridTemplateColumns: "44px minmax(0, 1fr) auto" }}>
                <div className="muted small">{shortDate(new Date(r.created_at))}</div>
                <div style={{ minWidth: 0 }}><b>{r.member_name}</b> <span className="muted small">· {r.text}</span>{r.product_name ? <div className="muted small">→ {productLabel({ name: r.product_name, variant: r.product_variant, maker: r.product_maker })}</div> : null}{r.reply ? <div className="muted small">&ldquo;{r.reply}&rdquo;</div> : null}</div>
                <div className="actions" style={{ gridColumn: "auto" }}>
                  <span className={`tag ${r.status === "added" ? "paid" : "unpaid"}`}>{REQUEST_STATUS_LABEL[r.status]}</span>
                  <form action={decideRequest}><input type="hidden" name="request_id" value={r.id} /><button className="btn quiet sm" name="status" value="open" title="Back to open">Reopen</button></form>
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
    </section>
  );
}
