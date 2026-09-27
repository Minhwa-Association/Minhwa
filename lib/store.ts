/** Store — materials the association buys in Korea and sells to members. */

export const CATEGORY_ORDER = ["Brush", "Paper", "Colour"] as const;

export type Product = {
  id: string;
  code: string;
  category: string;
  subcategory: string | null;
  name: string;
  variant: string | null;
  maker: string | null;
  price_sek: number;
  stock: number;
  min_stock: number;
  active: boolean;
  sort: number;
  notes: string | null;
  photos?: string[] | null;   // v10: up to two storage paths, first = main picture
  cost_krw?: number | null;   // v12: latest purchase price per piece, in won
};

/** The price rule: members pay 1 kr per `krwPerSek` won (100 by default) — the gap to the real rate covers shipping, customs and VAT. */
export function priceFromCost(costKrw: number | string | null | undefined, krwPerSek: number): number | null {
  const c = Number(costKrw);
  if (!Number.isFinite(c) || c <= 0 || !krwPerSek) return null;
  return Math.round(c / krwPerSek);
}

/** "₩12,340" */
export function krw(n: number | string | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  return `₩${Math.round(v).toLocaleString("en-GB")}`;
}

export const PHOTO_BUCKET = "product-photos";
export const MAX_PHOTOS = 2;

/** "abc/1700000000-1.jpg" → "abc/1700000000-1_thumb.jpg" (the 240 px copy uploaded alongside) */
export function thumbPath(path: string): string {
  return path.replace(/(\.[a-z0-9]+)$/i, "_thumb$1");
}

/** Public URL of a photo in the product-photos bucket (the bucket is public to read). */
export function photoUrl(path: string, thumb = false): string {
  const base = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  return `${base}/storage/v1/object/public/${PHOTO_BUCKET}/${thumb ? thumbPath(path) : path}`;
}

/** "Barim brush · S · 백산" */
export function productLabel(p: Pick<Product, "name" | "variant" | "maker">): string {
  return [p.name, p.variant, p.maker].filter((x) => x && x.trim()).join(" · ");
}

/** Out (0) · Low (≤ min) · OK */
export function stockLevel(p: Pick<Product, "stock" | "min_stock">): "out" | "low" | "ok" {
  if (p.stock <= 0) return "out";
  if (p.stock <= p.min_stock) return "low";
  return "ok";
}

/** What a member sees: in stock now, or it goes on the next group order from Korea. */
export function availability(p: Pick<Product, "stock" | "min_stock">): { text: string; cls: "paid" | "pending" } {
  return p.stock > 0 ? { text: "In stock", cls: "paid" } : { text: "Next group order", cls: "pending" };
}

export type CategoryGroup = { category: string; groups: { subcategory: string; items: Product[] }[] };

/** Products → categories (fixed order, unknown ones last) → subcategories (alphabetical) */
export function groupProducts(products: Product[]): CategoryGroup[] {
  const cats = new Map<string, Map<string, Product[]>>();
  for (const p of products) {
    const c = cats.get(p.category) ?? new Map<string, Product[]>();
    const sub = p.subcategory?.trim() || "Other";
    c.set(sub, [...(c.get(sub) ?? []), p]);
    cats.set(p.category, c);
  }
  const order = (c: string) => { const i = (CATEGORY_ORDER as readonly string[]).indexOf(c); return i < 0 ? 99 : i; };
  return [...cats.entries()]
    .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
    .map(([category, subs]) => ({
      category,
      groups: [...subs.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([subcategory, items]) => ({ subcategory, items: items.sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name)) })),
    }));
}

/** A row of orders_view */
export type OrderRow = {
  id: string;
  member_id: string;
  member_name: string;
  note: string | null;
  created_at: string;
  payment_id: string | null;
  code: string | null;
  payment_status: string | null;
  total_sek: number | null;
  claimed_at: string | null;
  confirmed_at: string | null;
  item_count: number;
  items_summary: string | null;
  status: "awaiting_payment" | "in_progress" | "ready" | "collected" | "cancelled" | "refunded";
};

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string;
  qty: number;
  unit_price_sek: number;
  name: string;
  status: "awaiting_payment" | "paid" | "preparing" | "group_buy" | "ready" | "collected" | "cancelled" | "refunded";
  batch_id: string | null;
  updated_at: string;
};

export const ORDER_STATUS_LABEL: Record<OrderRow["status"], string> = {
  awaiting_payment: "Awaiting payment",
  in_progress: "Paid · being prepared",
  ready: "Ready to collect",
  collected: "Collected",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

export const LINE_STATUS_LABEL: Record<OrderItem["status"], string> = {
  awaiting_payment: "Awaiting payment",
  paid: "Paid",
  preparing: "Being prepared",
  group_buy: "On the next group order",
  ready: "Ready to collect",
  collected: "Collected",
  cancelled: "Cancelled",
  refunded: "Refunded",
};

/** card colour for an order: green = ready/collected, gold = paid and waiting, plain otherwise */
export function orderClass(s: OrderRow["status"]): "paid" | "pending" | "" {
  if (s === "ready" || s === "collected") return "paid";
  if (s === "in_progress") return "pending";
  return "";
}

/** "Order #O0012" style heading */
export function orderTitle(o: Pick<OrderRow, "code">): string {
  return o.code ? `Order ${o.code}` : "Order";
}

// ---- step 2b: group orders · requests ---------------------------------------

export type Batch = {
  id: string;
  name: string;
  status: "open" | "ordered" | "arrived";
  ordered_at: string | null;
  arrived_at: string | null;
  cost_krw: number;
  fx_sek_per_krw: number | null;
  shipping_sek: number;
  customs_sek: number;
  vat_sek: number;
  notes: string | null;
  created_at: string;
};

/** What members can see of a group order */
export type BatchPublic = Pick<Batch, "id" | "name" | "status" | "ordered_at" | "arrived_at">;

export const BATCH_STATUS_LABEL: Record<Batch["status"], string> = {
  open: "Collecting",
  ordered: "Ordered — on its way",
  arrived: "Arrived",
};

/** A row of purchase_list_view: one product on a group order */
export type PurchaseListRow = {
  batch_id: string;
  batch_status: Batch["status"];
  product_id: string;
  code: string;
  name: string;
  variant: string | null;
  maker: string | null;
  category: string;
  subcategory: string | null;
  price_sek: number;
  stock: number;
  min_stock: number;
  sort: number;
  member_qty: number;
  waiting_qty: number;
  member_value_sek: number;
  orders: number;
  restock_qty: number;
  unit_cost_krw: number | null;
  total_qty: number;
};

/** Goods in SEK from KRW × rate, and the whole cost of a group order */
export function batchCosts(b: Pick<Batch, "cost_krw" | "fx_sek_per_krw" | "shipping_sek" | "customs_sek" | "vat_sek">) {
  const goods = b.fx_sek_per_krw ? Math.round(Number(b.cost_krw) * Number(b.fx_sek_per_krw)) : 0;
  const total = goods + Number(b.shipping_sek) + Number(b.customs_sek) + Number(b.vat_sek);
  return { goods, total };
}

/** "2026-10 Korea" — the default name for a new group order */
export function defaultBatchName(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")} Korea`;
}

export type RequestRow = {
  id: string;
  member_id: string;
  member_name: string;
  text: string;
  status: "open" | "quoted" | "added" | "declined";
  product_id: string | null;
  reply: string | null;
  created_at: string;
  decided_at: string | null;
  product_name: string | null;
  product_variant: string | null;
  product_maker: string | null;
  product_active: boolean | null;
  order_id?: string | null;          // v12: the order created by a quote
  quote_sek?: number | null;
  order_status?: OrderRow["status"] | null;
  payment_status?: string | null;
};

export const REQUEST_STATUS_LABEL: Record<RequestRow["status"], string> = {
  open: "Waiting for the treasurer",
  quoted: "Price offered",
  added: "Added to the Store",
  declined: "Not possible",
};
