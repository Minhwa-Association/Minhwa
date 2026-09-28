"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseCalendar, canUsePayments, cleanRoles, hasRole } from "@/lib/roles";
import { isValidISODate } from "@/lib/dates";
import { keyToAudience } from "@/lib/calendar";
import { decodeStatement, parseNordea } from "@/lib/nordea";
import { MAX_PHOTOS, PHOTO_BUCKET, thumbPath } from "@/lib/store";
import { after } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { finishClaim } from "@/lib/claims-process";

function backWithError(path: string, message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}error=${encodeURIComponent(message)}`);
}

function withOk(path: string, ok: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}ok=${ok}`;
}

export async function bookSeat(formData: FormData) {
  const slotId = String(formData.get("slot_id"));
  const date = String(formData.get("date"));
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("book_seat", { p_slot_id: slotId, p_date: date });
  if (error) backWithError(`/slot/${slotId}/${date}`, error.message);
  revalidatePath("/");
  redirect(`/pay/${data}`);
}

export async function cancelBooking(formData: FormData) {
  const id = String(formData.get("booking_id"));
  const back = String(formData.get("back") || "/me");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_booking", { p_booking_id: id });
  if (error) backWithError(back, error.message);
  revalidatePath("/");
  revalidatePath("/me");
  revalidatePath("/admin");
  revalidatePath("/payments");
  redirect(withOk(back, "cancelled"));
}

// ---- payments: member side --------------------------------------------------

/** "I have paid" — the payment waits for the treasurer to see it in the bank. */
export async function claimPayment(formData: FormData) {
  const paymentId = String(formData.get("payment_id"));
  const back = String(formData.get("back") || "/me");
  const supabase = await createClient();
  const { error } = await supabase.rpc("claim_payment", { p_payment_id: paymentId });
  if (error) backWithError(back, error.message);
  revalidatePath("/me");
  revalidatePath("/store/orders");
  revalidatePath("/payments");
  redirect(withOk(back, back.startsWith("/store") ? "order_paid" : "paid"));
}

// ---- payments: treasurer / admin -------------------------------------------

function refreshPayments() {
  revalidatePath("/payments");
  revalidatePath("/admin");
  revalidatePath("/me");
  revalidatePath("/");
}

async function treasurer() {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  return me;
}

/** Confirm one payment — from the admin board ("Mark paid"), the waiting list, or tied to a bank line. */
export async function confirmPayment(formData: FormData) {
  await treasurer();
  const paymentId = String(formData.get("payment_id"));
  const txId = String(formData.get("tx_id") || "") || null;
  const back = String(formData.get("back") || "/payments");
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_payment", { p_payment_id: paymentId, p_tx_id: txId });
  if (error) backWithError(back, error.message);
  refreshPayments();
  redirect(withOk(back, "confirmed"));
}

/** Confirm every bank line that was matched by its payment code. */
export async function confirmMatched() {
  await treasurer();
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("confirm_matched");
  if (error) backWithError("/payments", error.message);
  refreshPayments();
  redirect(`/payments?ok=confirmed_all&n=${Number(data) || 0}`);
}

/** "Not this one" — drop a suggestion / code match; the bank line waits again. */
export async function rejectMatch(formData: FormData) {
  await treasurer();
  const txId = String(formData.get("tx_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("reject_match", { p_tx_id: txId });
  if (error) backWithError("/payments", error.message);
  refreshPayments();
  redirect("/payments?ok=rejected");
}

/** A bank line the treasurer picks a payment for by hand → confirmed, and the payer's bank name is remembered. */
export async function attachTransaction(formData: FormData) {
  await treasurer();
  const txId = String(formData.get("tx_id"));
  const paymentId = String(formData.get("payment_id") || "");
  if (!paymentId) backWithError("/payments", "Pick the payment this bank line belongs to.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_payment", { p_payment_id: paymentId, p_tx_id: txId });
  if (error) backWithError("/payments", error.message);
  refreshPayments();
  redirect("/payments?ok=confirmed");
}

export async function ignoreTransaction(formData: FormData) {
  await treasurer();
  const txId = String(formData.get("tx_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("ignore_transaction", { p_tx_id: txId });
  if (error) backWithError("/payments", error.message);
  refreshPayments();
  redirect("/payments?ok=ignored");
}

export async function restoreTransaction(formData: FormData) {
  await treasurer();
  const txId = String(formData.get("tx_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("restore_transaction", { p_tx_id: txId });
  if (error) backWithError("/payments?show=other", error.message);
  refreshPayments();
  redirect("/payments?ok=restored");
}

export async function undoConfirmation(formData: FormData) {
  await treasurer();
  const paymentId = String(formData.get("payment_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("undo_confirmation", { p_payment_id: paymentId });
  if (error) backWithError("/payments", error.message);
  refreshPayments();
  redirect("/payments?ok=undone");
}

/** Paste (or upload) the Nordea statement → new lines are stored once and matched automatically. */
export async function importBank(formData: FormData) {
  await treasurer();
  let text = String(formData.get("rows") || "");
  const file = formData.get("file");
  if (file && typeof file === "object" && "arrayBuffer" in file && (file as File).size > 0) {
    text += "\n" + decodeStatement(await (file as File).arrayBuffer());
  }
  const { rows, skipped } = parseNordea(text);
  if (rows.length === 0) {
    backWithError("/payments", skipped.length
      ? `Couldn't read those ${skipped.length} line${skipped.length === 1 ? "" : "s"} — paste the rows as Nordea exports them (Bokföringsdag;Belopp;…;Rubrik;Saldo).`
      : "Paste the statement lines first.");
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("import_bank_rows", { p_rows: rows });
  if (error) backWithError("/payments", error.message);
  const r = (data ?? {}) as { added?: number; duplicates?: number; matched?: number; suggested?: number };
  refreshPayments();
  redirect(`/payments?ok=imported&added=${r.added ?? 0}&dup=${r.duplicates ?? 0}&matched=${r.matched ?? 0}&sugg=${r.suggested ?? 0}&skipped=${skipped.length}`);
}

// ---- store: member side -----------------------------------------------------

/** The Store form: one qty_<productId> field per product → one order, one payment (code O…). */
export async function placeOrder(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const items: { product_id: string; qty: number }[] = [];
  for (const [key, value] of formData.entries()) {
    if (!key.startsWith("qty_")) continue;
    const qty = Math.floor(Number(value));
    if (Number.isFinite(qty) && qty > 0) items.push({ product_id: key.slice(4), qty: Math.min(qty, 99) });
  }
  if (items.length === 0) backWithError("/store", "Choose at least one item — enter how many you want.");
  const note = String(formData.get("note") || "").trim() || null;
  const supabase = await createClient();
  const useCredits = formData.get("use_credits") === "on";
  const { data, error } = await supabase.rpc("place_order", { p_items: items, p_note: note, p_use_credits: useCredits });
  if (error) backWithError("/store", error.message);
  revalidatePath("/store");
  revalidatePath("/store/orders");
  revalidatePath("/payments");
  if (useCredits) revalidatePath("/me");
  redirect(`/store/orders/${data}`);
}

export async function cancelOrder(formData: FormData) {
  const orderId = String(formData.get("order_id"));
  const back = String(formData.get("back") || "/store/orders");
  const supabase = await createClient();
  const { error } = await supabase.rpc("cancel_order", { p_order_id: orderId });
  if (error) backWithError(back, error.message);
  revalidatePath("/store/orders");
  revalidatePath("/store/admin");
  revalidatePath("/payments");
  redirect(withOk(back, "order_cancelled"));
}

// ---- store: treasurer / admin -----------------------------------------------

function refreshStore() {
  revalidatePath("/store");
  revalidatePath("/store/admin");
  revalidatePath("/store/orders");
  revalidatePath("/payments");
}

function readProductForm(formData: FormData) {
  const price = Math.round(Number(formData.get("price_sek")));
  const minStock = Math.round(Number(formData.get("min_stock")));
  return {
    category: String(formData.get("category") || "").trim(),
    subcategory: String(formData.get("subcategory") || "").trim() || null,
    name: String(formData.get("name") || "").trim(),
    variant: String(formData.get("variant") || "").trim() || null,
    maker: String(formData.get("maker") || "").trim() || null,
    price_sek: Number.isFinite(price) && price >= 0 ? price : NaN,
    min_stock: Number.isFinite(minStock) && minStock >= 0 ? minStock : 5,
    active: formData.get("active") === "on",
    notes: String(formData.get("notes") || "").trim() || null,
    cost_krw: (() => { const c = String(formData.get("cost_krw") || "").replace(/[^0-9]/g, ""); return c ? Number(c) : null; })(),
  };
}

export async function saveProduct(formData: FormData) {
  await treasurer();
  const id = String(formData.get("product_id"));
  const row = readProductForm(formData);
  if (!row.name) backWithError("/store/admin", "The product needs a name.");
  if (!row.category) backWithError("/store/admin", "Pick a category.");
  if (Number.isNaN(row.price_sek)) backWithError("/store/admin", "Enter the price in whole kronor.");
  const supabase = await createClient();
  const { error } = await supabase.from("products").update(row).eq("id", id);
  if (error) backWithError("/store/admin", error.message);
  refreshStore();
  redirect("/store/admin?ok=saved");
}

export async function addProduct(formData: FormData) {
  await treasurer();
  const row = readProductForm(formData);
  const code = String(formData.get("code") || "").trim() || row.name;
  const opening = Math.round(Number(formData.get("opening_stock") || 0));
  if (!row.name) backWithError("/store/admin", "The product needs a name.");
  if (!row.category) backWithError("/store/admin", "Pick a category.");
  if (Number.isNaN(row.price_sek)) backWithError("/store/admin", "Enter the price in whole kronor.");
  const supabase = await createClient();
  const { data, error } = await supabase.from("products").insert({ ...row, code }).select("id").single();
  if (error) backWithError("/store/admin", error.code === "23505" ? `There is already a product with the code "${code}".` : error.message);
  if (Number.isFinite(opening) && opening > 0) {
    const { error: e2 } = await supabase.rpc("adjust_stock", { p_product_id: data.id, p_qty: opening, p_note: "Opening stock" });
    if (e2) backWithError("/store/admin", e2.message);
  }
  refreshStore();
  redirect("/store/admin?ok=product_added");
}

export async function adjustStock(formData: FormData) {
  await treasurer();
  const productId = String(formData.get("product_id"));
  const qty = Math.round(Number(formData.get("qty")));
  const note = String(formData.get("note") || "").trim() || null;
  if (!Number.isFinite(qty) || qty === 0) backWithError("/store/admin", "Enter how many to add (+) or take away (−).");
  const supabase = await createClient();
  const { error } = await supabase.rpc("adjust_stock", { p_product_id: productId, p_qty: qty, p_note: note });
  if (error) backWithError("/store/admin", error.message);
  refreshStore();
  redirect("/store/admin?ok=stock");
}

export async function fulfilFromStock(formData: FormData) {
  await treasurer();
  const itemId = String(formData.get("item_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("fulfil_from_stock", { p_item_id: itemId });
  if (error) backWithError("/store/admin", error.message);
  refreshStore();
  redirect("/store/admin?ok=handed");
}

// ---- store: group orders from Korea (step 2b) --------------------------------

const ADMIN = "/store/admin";

/** Call a store function as the treasurer; on error go back to Manage with the message. */
async function storeRpc(fn: string, args: Record<string, unknown>) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) backWithError(ADMIN, error.message);
  refreshStore();
  return data;
}

export async function startBatch(formData: FormData) {
  await treasurer();
  const name = String(formData.get("name") || "").trim();
  await storeRpc("start_batch", { p_name: name });
  redirect(`${ADMIN}?ok=batch_started`);
}

export async function addLineToBatch(formData: FormData) {
  await treasurer();
  await storeRpc("add_line_to_batch", { p_item_id: String(formData.get("item_id")) });
  redirect(`${ADMIN}?ok=batch_line`);
}

export async function addAllWaitingToBatch() {
  await treasurer();
  const n = await storeRpc("add_all_waiting_to_batch", {});
  redirect(`${ADMIN}?ok=batch_lines&n=${Number(n) || 0}`);
}

export async function removeLineFromBatch(formData: FormData) {
  await treasurer();
  await storeRpc("remove_line_from_batch", { p_item_id: String(formData.get("item_id")) });
  redirect(`${ADMIN}?ok=saved`);
}

export async function setRestock(formData: FormData) {
  await treasurer();
  const qty = Math.round(Number(formData.get("restock_qty")));
  const costRaw = String(formData.get("unit_cost_krw") || "").replace(/[^0-9.]/g, "");
  if (!Number.isFinite(qty) || qty < 0) backWithError(ADMIN, "Restock must be 0 or more.");
  await storeRpc("set_restock", {
    p_batch_id: String(formData.get("batch_id")),
    p_product_id: String(formData.get("product_id")),
    p_qty: qty,
    p_unit_cost_krw: costRaw ? Number(costRaw) : null,
  });
  redirect(`${ADMIN}?ok=saved`);
}

export async function suggestRestock(formData: FormData) {
  await treasurer();
  const n = await storeRpc("suggest_restock", { p_batch_id: String(formData.get("batch_id")) });
  redirect(`${ADMIN}?ok=restock&n=${Number(n) || 0}`);
}

export async function saveBatchCosts(formData: FormData) {
  await treasurer();
  const num = (k: string) => { const v = String(formData.get(k) || "").replace(/[^0-9.,-]/g, "").replace(",", "."); return v ? Number(v) : 0; };
  const fxRaw = String(formData.get("fx_sek_per_krw") || "").replace(",", ".").trim();
  await storeRpc("save_batch_costs", {
    p_batch_id: String(formData.get("batch_id")),
    p_cost_krw: Math.round(num("cost_krw")),
    p_fx: fxRaw ? Number(fxRaw) : null,
    p_shipping: Math.round(num("shipping_sek")),
    p_customs: Math.round(num("customs_sek")),
    p_vat: Math.round(num("vat_sek")),
    p_notes: String(formData.get("notes") || ""),
  });
  redirect(`${ADMIN}?ok=saved`);
}

export async function markBatchOrdered(formData: FormData) {
  await treasurer();
  await storeRpc("mark_batch_ordered", { p_batch_id: String(formData.get("batch_id")) });
  redirect(`${ADMIN}?ok=batch_ordered`);
}

export async function markBatchArrived(formData: FormData) {
  await treasurer();
  await storeRpc("mark_batch_arrived", { p_batch_id: String(formData.get("batch_id")) });
  redirect(`${ADMIN}?ok=batch_arrived`);
}

export async function refundLine(formData: FormData) {
  await treasurer();
  const res = (await storeRpc("refund_order_item", { p_item_id: String(formData.get("item_id")), p_note: String(formData.get("note") || "") || null })) as { credits?: number; swish?: number } | null;
  const c = Number(res?.credits ?? 0), sw = Number(res?.swish ?? 0);
  revalidatePath("/me");
  redirect(c > 0 ? `${ADMIN}?ok=refunded_credits&c=${c}&s=${sw}` : `${ADMIN}?ok=refunded`);
}

/** Set a product's price (and, when given, its latest cost) — from the shopping list's "Set price". */
export async function setProductPrice(formData: FormData) {
  await treasurer();
  const price = Math.round(Number(formData.get("price_sek")));
  const costRaw = String(formData.get("cost_krw") || "").replace(/[^0-9]/g, "");
  if (!Number.isFinite(price) || price < 0) backWithError(ADMIN, "Enter the price in whole kronor.");
  await storeRpc("set_product_price", { p_product_id: String(formData.get("product_id")), p_price_sek: price, p_cost_krw: costRaw ? Number(costRaw) : null });
  redirect(`${ADMIN}?ok=saved`);
}

/** "We can buy this for you for X kr" → hidden product + an order the member pays; then it runs like any order. */
export async function quoteRequest(formData: FormData) {
  await treasurer();
  const name = String(formData.get("name") || "").trim();
  const qty = Math.max(1, Math.round(Number(formData.get("qty") || 1)));
  const costRaw = String(formData.get("cost_krw") || "").replace(/[^0-9]/g, "");
  const priceRaw = String(formData.get("price_sek") || "").replace(/[^0-9]/g, "");
  if (!name) backWithError(ADMIN, "Give the item a name.");
  let price = priceRaw ? Number(priceRaw) : NaN;
  if (!Number.isFinite(price) && costRaw) {
    // no price typed → the rule: 1 kr per N won (settings.price_krw_per_sek)
    const supabase = await createClient();
    const { data: st } = await supabase.from("settings").select("price_krw_per_sek").eq("id", 1).single();
    price = Math.round(Number(costRaw) / Math.max(1, Number(st?.price_krw_per_sek ?? 100)));
  }
  if (!Number.isFinite(price) || price <= 0) backWithError(ADMIN, "Set the price in kronor — type it, or give the cost in won and the price follows the rule.");
  await storeRpc("quote_request", {
    p_request_id: String(formData.get("request_id")),
    p_name: name,
    p_price_sek: price,
    p_qty: qty,
    p_cost_krw: costRaw ? Number(costRaw) : null,
    p_reply: String(formData.get("reply") || "") || null,
  });
  redirect(`${ADMIN}?ok=quoted`);
}

// ---- store: requests -----------------------------------------------------------

export async function createRequest(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const text = String(formData.get("text") || "").trim();
  if (text.length < 3) backWithError("/store", "Tell us what you are looking for.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_request", { p_text: text });
  if (error) backWithError("/store", error.message);
  revalidatePath("/store");
  revalidatePath("/store/orders");
  revalidatePath(ADMIN);
  redirect("/store/orders?ok=requested");
}

export async function decideRequest(formData: FormData) {
  await treasurer();
  const status = String(formData.get("status") || "");
  const productId = String(formData.get("product_id") || "") || null;
  if (status === "added" && !productId) backWithError(ADMIN, "Pick the product you added for this request.");
  await storeRpc("decide_request", {
    p_id: String(formData.get("request_id")),
    p_status: status,
    p_product_id: productId,
    p_reply: String(formData.get("reply") || "") || null,
  });
  redirect(`${ADMIN}?ok=saved`);
}

// ---- store: product photos (the browser uploads the files; these only record the paths) ----

type PhotoResult = { ok: true; photos: string[] } | { error: string };

async function photoTreasurer() {
  const me = await currentMember();
  if (!me || !canUsePayments(me)) return null;
  return me;
}

async function deletePhotoFiles(supabase: Awaited<ReturnType<typeof createClient>>, paths: string[]) {
  const files = paths.flatMap((p) => [p, thumbPath(p)]);
  if (files.length) await supabase.storage.from(PHOTO_BUCKET).remove(files);
}

/** A picture was uploaded → put it at position index (0 = main, 1 = second); the old file at that position is deleted. */
export async function setPhoto(productId: string, index: number, path: string): Promise<PhotoResult> {
  if (!(await photoTreasurer())) return { error: "Treasurer or Admin only" };
  if (!path.startsWith(`${productId}/`)) return { error: "That file does not belong to this product" };
  const supabase = await createClient();
  const { data: p, error } = await supabase.from("products").select("photos").eq("id", productId).single();
  if (error || !p) return { error: error?.message ?? "Product not found" };
  const photos = [...((p.photos as string[] | null) ?? [])];
  const i = Math.max(0, Math.min(index, photos.length, MAX_PHOTOS - 1));
  const old = photos[i];
  photos[i] = path;
  const { error: e2 } = await supabase.from("products").update({ photos }).eq("id", productId);
  if (e2) return { error: e2.message };
  if (old && old !== path) await deletePhotoFiles(supabase, [old]);
  refreshStore();
  return { ok: true, photos };
}

export async function removePhoto(productId: string, index: number): Promise<PhotoResult> {
  if (!(await photoTreasurer())) return { error: "Treasurer or Admin only" };
  const supabase = await createClient();
  const { data: p, error } = await supabase.from("products").select("photos").eq("id", productId).single();
  if (error || !p) return { error: error?.message ?? "Product not found" };
  const photos = [...((p.photos as string[] | null) ?? [])];
  const [old] = photos.splice(index, 1);
  const { error: e2 } = await supabase.from("products").update({ photos }).eq("id", productId);
  if (e2) return { error: e2.message };
  if (old) await deletePhotoFiles(supabase, [old]);
  refreshStore();
  return { ok: true, photos };
}

export async function markCollected(formData: FormData) {
  await treasurer();
  const itemId = String(formData.get("item_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_collected", { p_item_id: itemId });
  if (error) backWithError("/store/admin", error.message);
  refreshStore();
  redirect("/store/admin?ok=collected");
}

// ---- profile / settings -----------------------------------------------------

export async function saveName(formData: FormData) {
  const name = String(formData.get("name") || "").trim();
  if (name.length < 1) backWithError("/welcome", "Please enter your name.");
  const me = await currentMember();
  if (!me) redirect("/login");
  const supabase = await createClient();
  const { error } = await supabase.from("members").update({ name }).eq("id", me.id);
  if (error) backWithError("/welcome", error.message);
  revalidatePath("/");
  redirect("/");
}

export async function updateSettings(formData: FormData) {
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) redirect("/");
  const supabase = await createClient();
  const { error } = await supabase.from("settings").update({
    seat_price_sek: Number(formData.get("seat_price_sek")),
    swish_number: String(formData.get("swish_number")).replace(/[^0-9]/g, ""),
    swish_payee_name: String(formData.get("swish_payee_name")),
    booking_window_weeks: Number(formData.get("booking_window_weeks")),
    cancel_deadline_days: Number(formData.get("cancel_deadline_days")),
    max_extra_seats: Number(formData.get("max_extra_seats")),
    ...(formData.has("price_krw_per_sek") ? { price_krw_per_sek: Math.max(1, Math.round(Number(formData.get("price_krw_per_sek")) || 100)) } : {}),
  }).eq("id", 1);
  if (error) backWithError("/admin/settings", error.message);
  revalidatePath("/");
  redirect("/admin/settings?ok=saved");
}

export async function setInstructor(formData: FormData) {
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) redirect("/");
  const slotId = String(formData.get("slot_id"));
  const raw = String(formData.get("instructor_id") || "");
  const supabase = await createClient();
  const { error } = await supabase.from("slots").update({ instructor_id: raw || null }).eq("id", slotId);
  if (error) backWithError("/admin/settings", error.message);
  revalidatePath("/");
  redirect("/admin/settings?ok=saved");
}

export async function setSlotWhatsapp(formData: FormData) {
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) redirect("/");
  const slotId = String(formData.get("slot_id"));
  const raw = String(formData.get("whatsapp_url") || "").trim();
  if (raw && !/^https:\/\/chat\.whatsapp\.com\//.test(raw)) backWithError("/admin/settings", "Paste the group invite link (starts with https://chat.whatsapp.com/).");
  const supabase = await createClient();
  const { error } = await supabase.from("slots").update({ whatsapp_url: raw || null }).eq("id", slotId);
  if (error) backWithError("/admin/settings", error.message);
  revalidatePath("/");
  redirect("/admin/settings?ok=saved");
}

export async function setRoles(formData: FormData) {
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) redirect("/");
  const memberId = String(formData.get("member_id"));
  const roles = cleanRoles(formData.getAll("roles"));
  if (memberId === me.id && !roles.includes("admin")) backWithError("/admin/settings", "You can't remove your own Admin role — ask another admin.");
  const supabase = await createClient();
  const { error } = await supabase.from("members").update({ roles }).eq("id", memberId);
  if (error) backWithError("/admin/settings", error.message);
  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=saved");
}

export async function addMember(formData: FormData) {
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) redirect("/");
  const name = String(formData.get("name") || "").trim();
  const phone = String(formData.get("phone") || "").trim();
  const roles = cleanRoles(formData.getAll("roles"));
  if (!name || !phone) backWithError("/admin/settings", "Name and phone are required.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("admin_add_member", { p_name: name, p_phone: phone, p_roles: roles });
  if (error) backWithError("/admin/settings", error.message);
  revalidatePath("/admin/settings");
  redirect("/admin/settings?ok=saved");
}


// ---- receipts: members' expense claims -------------------------------------------

const RECEIPTS = "/payments/receipts";
const MY_RECEIPTS = "/me/receipts";

function refreshReceipts() {
  revalidatePath(RECEIPTS);
  revalidatePath(MY_RECEIPTS);
  revalidatePath("/payments");
}

/** Call a claims function as the treasurer; on error go back to Receipts with the message. */
async function claimsRpc(fn: string, args: Record<string, unknown>) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) backWithError(RECEIPTS, error.message);
  refreshReceipts();
  return data;
}

function optText(formData: FormData, key: string): string | null | undefined {
  if (!formData.has(key)) return undefined;
  const v = String(formData.get(key) ?? "").trim();
  return v === "" ? null : v;
}

/** "345", "345,50", "1 234.5" → "345" / "345.50" / "1234.5"; "" → null; nonsense → error */
function money(formData: FormData, key: string): string | null | undefined {
  const v = optText(formData, key);
  if (v === undefined || v === null) return v;
  const cleaned = v.replace(/\s/g, "").replace(/kr$/i, "").replace(",", ".");
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) backWithError(RECEIPTS, `"${v}" is not an amount`);
  return cleaned;
}

/** "Who is this?" — the treasurer ties a claim from an unknown address to a member (and remembers the address). */
export async function linkClaimMember(formData: FormData) {
  await treasurer();
  const claimId = String(formData.get("claim_id"));
  const memberId = String(formData.get("member_id") || "");
  if (!memberId) backWithError(RECEIPTS, "Pick the member first.");
  await claimsRpc("link_claim_member", { p_claim_id: claimId, p_member_id: memberId, p_remember: formData.get("remember") !== null });
  redirect(`${RECEIPTS}?ok=linked`);
}

/** One form per claim: Save what was typed · Approve (with the amount) · Decline (with a reply). */
export async function decideClaim(formData: FormData) {
  await treasurer();
  const claimId = String(formData.get("claim_id"));
  const action = String(formData.get("do") || "save");
  const fields: Record<string, unknown> = {};
  for (const k of ["merchant", "purchased_on", "receipt_currency", "purpose", "category_code", "note"]) {
    const v = optText(formData, k);
    if (v !== undefined) fields[k] = v;
  }
  for (const k of ["receipt_total", "amount_sek", "vat_sek"]) {
    const v = money(formData, k);
    if (v !== undefined) fields[k] = v;
  }
  if (typeof fields.purchased_on === "string" && !isValidISODate(fields.purchased_on)) backWithError(RECEIPTS, "The date should be YYYY-MM-DD.");
  if (formData.get("not_duplicate") !== null) fields.not_duplicate = true;
  const supabase = await createClient();
  if (action !== "decline") {
    const { error } = await supabase.rpc("review_claim", { p_claim_id: claimId, p: fields });
    if (error) backWithError(RECEIPTS, error.message);
  }
  if (action === "approve") {
    const amount = money(formData, "amount_sek");
    if (!amount) backWithError(RECEIPTS, "Type the amount to pay back before approving.");
    const { error } = await supabase.rpc("approve_claim", { p_claim_id: claimId, p_amount_sek: Number(amount), p_category_code: fields.category_code ?? null, p_reply: optText(formData, "reply") ?? null });
    if (error) backWithError(RECEIPTS, error.message);
    refreshReceipts();
    redirect(`${RECEIPTS}?ok=approved`);
  }
  if (action === "decline") {
    const { error } = await supabase.rpc("decline_claim", { p_claim_id: claimId, p_reply: optText(formData, "reply") ?? null });
    if (error) backWithError(RECEIPTS, error.message);
    refreshReceipts();
    redirect(`${RECEIPTS}?ok=declined`);
  }
  refreshReceipts();
  redirect(`${RECEIPTS}?ok=saved`);
}

export async function reopenClaim(formData: FormData) {
  await treasurer();
  await claimsRpc("reopen_claim", { p_claim_id: String(formData.get("claim_id")) });
  redirect(`${RECEIPTS}?ok=reopened`);
}

/** Paid — with the suggested bank line, or by hand with a date. */
export async function markClaimPaid(formData: FormData) {
  await treasurer();
  const claimId = String(formData.get("claim_id"));
  const txId = String(formData.get("tx_id") || "") || null;
  const paidOn = String(formData.get("paid_on") || "") || null;
  if (paidOn && !isValidISODate(paidOn)) backWithError(RECEIPTS, "The date should be YYYY-MM-DD.");
  await claimsRpc("mark_claim_paid", { p_claim_id: claimId, p_tx_id: txId, p_paid_on: paidOn });
  redirect(`${RECEIPTS}?ok=claim_paid`);
}

export async function unpayClaim(formData: FormData) {
  await treasurer();
  await claimsRpc("unpay_claim", { p_claim_id: String(formData.get("claim_id")) });
  redirect(`${RECEIPTS}?ok=claim_unpaid`);
}

export async function rejectClaimSuggestion(formData: FormData) {
  await treasurer();
  await claimsRpc("reject_claim_suggestion", { p_claim_id: String(formData.get("claim_id")) });
  redirect(`${RECEIPTS}?ok=rejected`);
}

/** Look through the outgoing bank lines already imported for approved claims. */
export async function findClaimsInBank() {
  await treasurer();
  const data = (await claimsRpc("match_claims_to_bank", {})) as { suggested?: number } | null;
  redirect(`${RECEIPTS}?ok=looked&n=${data?.suggested ?? 0}`);
}

/** Read the receipt again with Claude (overwrites the reading; the treasurer's own typing stays where the reader has nothing). */
export async function rereadClaim(formData: FormData) {
  await treasurer();
  const claimId = String(formData.get("claim_id"));
  let r: Awaited<ReturnType<typeof finishClaim>>;
  try { r = await finishClaim(claimId, { sendAck: false, force: true }); }
  catch (e) { backWithError(RECEIPTS, e instanceof Error ? e.message : "Could not read the receipt"); }
  refreshReceipts();
  redirect(`${RECEIPTS}?ok=${r.read ? "reread" : "reread_failed"}${r.note ? `&note=${encodeURIComponent(r.note)}` : ""}`);
}

/** Send the "received" reply by hand — for a claim that was linked to its member after it came in. */
export async function sendClaimAck(formData: FormData) {
  await treasurer();
  const claimId = String(formData.get("claim_id"));
  let r: Awaited<ReturnType<typeof finishClaim>>;
  try { r = await finishClaim(claimId, { sendAck: true }); }
  catch (e) { backWithError(RECEIPTS, e instanceof Error ? e.message : "Could not send the reply"); }
  refreshReceipts();
  redirect(`${RECEIPTS}?ok=${r.acked ? "acked" : "ack_skipped"}`);
}

// ---- receipts: member side ---------------------------------------------------------

export async function saveBankAccount(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const supabase = await createClient();
  const { error } = await supabase.rpc("save_bank_account", {
    p_clearing: String(formData.get("clearing") || ""),
    p_account: String(formData.get("account") || ""),
    p_bank: String(formData.get("bank") || "") || null,
    p_holder: String(formData.get("holder") || "") || null,
  });
  if (error) backWithError(MY_RECEIPTS, error.message);
  refreshReceipts();
  redirect(`${MY_RECEIPTS}?ok=account_saved`);
}

export async function saveMyEmails(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const emails = String(formData.get("emails") || "").split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_my_extra_emails", { p_emails: emails });
  if (error) backWithError(MY_RECEIPTS, error.message);
  refreshReceipts();
  redirect(`${MY_RECEIPTS}?ok=emails_saved`);
}

type ClaimStart = { ok: true; claimId: string; code: string } | { error: string };
type ClaimFinish = { ok: true } | { error: string };

/** The app's upload, step 1: make the claim (the pictures follow from the browser, straight into the bucket). */
export async function startReceiptClaim(purpose: string): Promise<ClaimStart> {
  const me = await currentMember();
  if (!me) return { error: "Log in first" };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("import_claim", { p: { source: "app", body_text: purpose.trim().slice(0, 2000) || null, subject: "Uploaded in the app", files: [] } });
  if (error) return { error: error.message };
  const r = data as { claim_id: string; code: string };
  return { ok: true, claimId: r.claim_id, code: r.code };
}

/** Step 2: the files are in the bucket — record them, then read the receipt in the background (no reply mail: the member sees it here). */
export async function finishReceiptClaim(claimId: string, files: { path: string; filename: string; content_type: string; bytes: number; sha256: string }[]): Promise<ClaimFinish> {
  const me = await currentMember();
  if (!me) return { error: "Log in first" };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_claim_files", { p_claim_id: claimId, p_files: files });
  if (error) return { error: error.message };
  after(async () => {
    try { await finishClaim(claimId, { sendAck: false }); }
    catch (e) { console.error("finishClaim (app)", claimId, e instanceof Error ? e.message : e); }
  });
  refreshReceipts();
  return { ok: true };
}

/** A member takes back a receipt that is still being checked (nothing has been paid). */
export async function withdrawReceiptClaim(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const claimId = String(formData.get("claim_id"));
  const service = createServiceClient();
  const { data: c } = await service.from("expense_claims").select("id, member_id, status").eq("id", claimId).single();
  if (!c || c.member_id !== me.id) backWithError(MY_RECEIPTS, "Not your receipt.");
  if (c.status !== "new") backWithError(MY_RECEIPTS, "The treasurer has already handled this one — ask them directly.");
  const { data: files } = await service.from("claim_files").select("path").eq("claim_id", claimId);
  if (files?.length) await service.storage.from("receipts").remove(files.map((f) => f.path));
  await service.from("expense_claims").delete().eq("id", claimId);
  refreshReceipts();
  redirect(`${MY_RECEIPTS}?ok=withdrawn`);
}

// ---- credits (1 credit = 1 kr) ------------------------------------------------

const CREDITS = "/payments/credits";

function refreshCredits() {
  revalidatePath(CREDITS);
  revalidatePath("/me");
  revalidatePath("/me/credits");
  revalidatePath("/store");
  revalidatePath("/store/orders");
  revalidatePath("/store/admin");
  revalidatePath("/payments");
  revalidatePath("/");
}

/** Only paths inside the app — the form says where to come back to. */
function safeBack(formData: FormData, fallback: string): string {
  const back = String(formData.get("back") || "");
  return back.startsWith("/") && !back.startsWith("//") ? back : fallback;
}

/** Member: put my credits on an unpaid seat or order — Swish pays the rest. */
export async function applyCredits(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const back = safeBack(formData, "/me");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("apply_credits", { p_payment_id: String(formData.get("payment_id")) });
  if (error) backWithError(back, error.message);
  refreshCredits();
  redirect(`${back}${back.includes("?") ? "&" : "?"}ok=credits_used&c=${Number(data ?? 0)}`);
}

/** Member: take the credits off an unpaid payment and pay it all with Swish. */
export async function releaseCredits(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  const back = safeBack(formData, "/me");
  const supabase = await createClient();
  const { error } = await supabase.rpc("release_credits", { p_payment_id: String(formData.get("payment_id")) });
  if (error) backWithError(back, error.message);
  refreshCredits();
  redirect(withOk(back, "credits_released"));
}

/** Treasurer: give credits for an activity. */
export async function giveCredits(formData: FormData) {
  await treasurer();
  const memberId = String(formData.get("member_id") || "");
  const amount = Math.round(Number(String(formData.get("amount") || "").replace(/[^0-9-]/g, "")));
  const note = String(formData.get("note") || "").trim() || null;
  const eventId = String(formData.get("event_id") || "") || null;
  if (!memberId) backWithError(CREDITS, "Pick the member.");
  if (!Number.isFinite(amount) || amount <= 0) backWithError(CREDITS, "Enter how many credits, a whole number.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("give_credits", { p_member_id: memberId, p_amount: amount, p_note: note, p_event_id: eventId });
  if (error) backWithError(CREDITS, error.message);
  refreshCredits();
  redirect(`${CREDITS}?ok=credits_given&c=${amount}&m=${memberId}`);
}

/** Treasurer: correct a balance, + or − (with a reason). */
export async function adjustCredits(formData: FormData) {
  await treasurer();
  const memberId = String(formData.get("member_id") || "");
  const back = `${CREDITS}?m=${memberId}`;
  const amount = Math.round(Number(String(formData.get("amount") || "").replace(/[−–]/g, "-").replace(/[^0-9-]/g, "")));
  if (!Number.isFinite(amount) || amount === 0) backWithError(back, "Enter a number of credits, e.g. 50 or -50.");
  const supabase = await createClient();
  const { error } = await supabase.rpc("adjust_credits", { p_member_id: memberId, p_amount: amount, p_note: String(formData.get("note") || "") });
  if (error) backWithError(back, error.message);
  refreshCredits();
  redirect(withOk(back, "credits_adjusted"));
}

/** Treasurer: take back credits that were given (only while the member still has them). */
export async function voidCredits(formData: FormData) {
  await treasurer();
  const back = safeBack(formData, CREDITS);
  const supabase = await createClient();
  const { error } = await supabase.rpc("void_credits", { p_movement_id: String(formData.get("movement_id")) });
  if (error) backWithError(back, error.message);
  refreshCredits();
  redirect(withOk(back, "credits_voided"));
}

// ---- calendar ---------------------------------------------------------------

function canEditEvents(me: { roles?: string[] | null } | null) {
  return canUseCalendar(me);
}

const TIME = /^\d{2}:\d{2}$/;

function readEventForm(formData: FormData, back: string) {
  const title = String(formData.get("title") || "").trim();
  const date = String(formData.get("date") || "");
  const endRaw = String(formData.get("end_date") || "");
  const allDay = formData.get("all_day") === "on";
  const start = String(formData.get("start_time") || "");
  const end = String(formData.get("end_time") || "");
  const location = String(formData.get("location") || "").trim();
  const notes = String(formData.get("notes") || "").trim();
  const audience = keyToAudience(String(formData.get("audience") || "all"));

  if (!title) backWithError(back, "Give the event a title.");
  if (!isValidISODate(date)) backWithError(back, "Pick a date.");
  const end_date = endRaw && endRaw !== date ? endRaw : null;
  if (end_date && (!isValidISODate(end_date) || end_date < date)) backWithError(back, "The last day must be after the first day.");
  if (!allDay && !TIME.test(start)) backWithError(back, "Enter a start time, or tick All day.");
  const start_time = allDay ? null : start;
  const end_time = allDay || !TIME.test(end) ? null : end;
  if (start_time && end_time && !end_date && end_time <= start_time) backWithError(back, "The end time must be after the start time.");
  return { title, date, end_date, start_time, end_time, location: location || null, notes: notes || null, audience };
}

export async function createEvent(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canEditEvents(me)) redirect("/");
  const row = readEventForm(formData, "/calendar/new");
  const supabase = await createClient();
  const { data, error } = await supabase.from("events").insert({ ...row, created_by: me.id }).select("id").single();
  if (error) backWithError("/calendar/new", error.message);
  revalidatePath("/calendar");
  redirect(`/calendar/${data.id}?ok=event_saved`);
}

export async function updateEvent(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canEditEvents(me)) redirect("/");
  const id = String(formData.get("event_id") || "");
  const row = readEventForm(formData, `/calendar/${id}/edit`);
  const supabase = await createClient();
  const { error } = await supabase.from("events").update(row).eq("id", id);
  if (error) backWithError(`/calendar/${id}/edit`, error.message);
  revalidatePath("/calendar");
  revalidatePath(`/calendar/${id}`);
  redirect(`/calendar/${id}?ok=event_saved`);
}

export async function deleteEvent(formData: FormData) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canEditEvents(me)) redirect("/");
  const id = String(formData.get("event_id") || "");
  const supabase = await createClient();
  const { error } = await supabase.from("events").delete().eq("id", id);
  if (error) backWithError(`/calendar/${id}/edit`, error.message);
  revalidatePath("/calendar");
  redirect("/calendar?ok=event_deleted");
}

export async function resetCalendarLink() {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUseCalendar(me)) redirect("/");
  const supabase = await createClient();
  const { error } = await supabase.rpc("reset_calendar_token");
  if (error) backWithError("/calendar/subscribe", error.message);
  revalidatePath("/calendar/subscribe");
  redirect("/calendar/subscribe?ok=link_reset");
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
