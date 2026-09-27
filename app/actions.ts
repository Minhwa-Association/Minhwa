"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseCalendar, canUsePayments, cleanRoles, hasRole } from "@/lib/roles";
import { isValidISODate } from "@/lib/dates";
import { keyToAudience } from "@/lib/calendar";
import { decodeStatement, parseNordea } from "@/lib/nordea";
import { MAX_PHOTOS, PHOTO_BUCKET, thumbPath } from "@/lib/store";

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
  const { data, error } = await supabase.rpc("place_order", { p_items: items, p_note: note });
  if (error) backWithError("/store", error.message);
  revalidatePath("/store");
  revalidatePath("/store/orders");
  revalidatePath("/payments");
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
  await storeRpc("refund_order_item", { p_item_id: String(formData.get("item_id")), p_note: String(formData.get("note") || "") || null });
  redirect(`${ADMIN}?ok=refunded`);
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
