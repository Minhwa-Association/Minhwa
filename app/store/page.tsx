import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { availability, groupProducts, photoUrl, productLabel, type Product } from "@/lib/store";
import { createRequest, placeOrder } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { balanceOf, credits } from "@/lib/credits";

export default async function StorePage({ searchParams }: { searchParams: Promise<{ error?: string; ok?: string }> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const { error, ok } = await searchParams;
  const supabase = await createClient();
  const [{ data: products }, { data: settings }, { count: openOrders }, balance] = await Promise.all([
    supabase.from("products").select("*").eq("active", true).order("sort").order("name"),
    supabase.from("settings").select("swish_payee_name").eq("id", 1).single(),
    supabase.from("orders_view").select("id", { count: "exact", head: true }).eq("member_id", me.id).in("status", ["awaiting_payment", "in_progress", "ready"]),
    balanceOf(supabase, me.id),
  ]);
  const groups = groupProducts((products ?? []) as Product[]);
  const treasurer = canUsePayments(me);

  return (
    <main className="page">
      <div className="topbar">
        <div><h1>Store</h1><div className="muted small">Materials from Korea · pay with Swish · collect at the studio</div></div>
        <TopNav current="store" me={me} />
      </div>

      <div className="stack">
        <Notice error={error} ok={ok} />
        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <Link href="/store/orders" className="btn line sm">My orders{openOrders ? ` · ${openOrders} open` : ""}</Link>
          {treasurer && <Link href="/store/admin" className="btn line sm">Manage store</Link>}
        </div>
        <div className="muted small">Enter how many you want, then order. If something is not in stock it goes on the next group order from Korea — you still pay now and collect it when it arrives.</div>

        <form action={placeOrder} className="stack" style={{ gap: 16 }}>
          {groups.length === 0 && <div className="card dashed" style={{ padding: 24, textAlign: "center" }}>Nothing on the list yet.</div>}
          {groups.map((g) => (
            <section key={g.category} className="card stack" style={{ padding: 16, gap: 10 }}>
              <h2>{g.category}</h2>
              {g.groups.map((sg) => (
                <div key={sg.subcategory} className="stack" style={{ gap: 0 }}>
                  {(g.groups.length > 1 || sg.subcategory !== "Other") && <div className="sublabel">{sg.subcategory}</div>}
                  {sg.items.map((p) => {
                    const a = availability(p);
                    const photos = p.photos ?? [];
                    return (
                      <div key={p.id} className="prow">
                        <span className="pthumbs">
                          {photos.map((ph, i) => (
                            <a key={ph} href={photoUrl(ph)} target="_blank" rel="noopener noreferrer" className="pthumb small" title={`${productLabel(p)} — photo ${i + 1}`}>
                              <img src={photoUrl(ph, true)} alt={`${productLabel(p)} ${i + 1}`} width={44} height={44} loading="lazy" />
                            </a>
                          ))}
                        </span>
                        <label htmlFor={`qty_${p.id}`} style={{ minWidth: 0, margin: 0, color: "var(--ink)", fontSize: 15 }}>
                          <span className="bold">{p.name}</span>
                          {(p.variant || p.maker) && <span className="muted"> · {[p.variant, p.maker].filter(Boolean).join(" · ")}</span>}
                          <span className={`tag ${a.cls}`} style={{ marginLeft: 8 }}>{a.text}</span>
                        </label>
                        <span className="price">{p.price_sek} kr</span>
                        <input id={`qty_${p.id}`} className="qty" type="number" inputMode="numeric" name={`qty_${p.id}`} min={0} max={99} placeholder="0" aria-label={`How many: ${productLabel(p)}`} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </section>
          ))}
          <div className="card stack" style={{ padding: 16 }}>
            <label htmlFor="note">Note to the treasurer <span style={{ opacity: 0.7 }}>(optional)</span></label>
            <textarea id="note" name="note" rows={2} maxLength={300} placeholder="e.g. I can collect on Tuesday evening" />
          </div>
          <div className="footer" style={{ marginTop: 0 }}>
            {balance > 0 && (
              <label className="check credituse">
                <input type="checkbox" name="use_credits" defaultChecked />
                <span>Use my credits first · <b>{credits(balance)}</b> <span className="muted" style={{ fontWeight: 500 }}>(1 credit = 1 kr)</span></span>
              </label>
            )}
            <button className="btn red">{balance > 0 ? "Order & pay" : "Order & pay with Swish"}</button>
            <div className="muted small" style={{ textAlign: "center" }}>
              {balance > 0
                ? <>Credits cover what they can; Swish to {settings?.swish_payee_name ?? "the association"} opens on the next page for the rest.</>
                : <>Swish to {settings?.swish_payee_name ?? "the association"} opens on the next page with the total and a payment code.</>}
            </div>
          </div>
        </form>

        <form action={createRequest} className="card stack" style={{ padding: 16, marginTop: 8 }}>
          <div><div className="bold">Something missing?</div><div className="muted small">Ask for a material that is not on the list. The treasurer answers under My orders — and adds it to the Store if it can be bought in Korea.</div></div>
          <textarea name="text" rows={2} maxLength={500} required minLength={3} placeholder="e.g. gold leaf sheets for outlines, or a larger backing paper" />
          <button className="btn line sm" style={{ alignSelf: "flex-start" }}>Send request</button>
        </form>
      </div>
    </main>
  );
}
