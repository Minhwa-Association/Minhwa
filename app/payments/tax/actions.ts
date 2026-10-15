"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { isValidISODate } from "@/lib/dates";

/** Payments → Tax check (v18): what the treasurer can change on that page. */

const PAGE = "/payments/tax";

function back(year: string | null, extra: string): never {
  const y = year ? `year=${encodeURIComponent(year)}&` : "";
  redirect(`${PAGE}?${y}${extra}`);
}

async function treasurer() {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  return me;
}

function refresh() {
  revalidatePath(PAGE);
  revalidatePath("/payments");
}

function yearOf(formData: FormData): string | null {
  const y = String(formData.get("year") ?? "").trim();
  return /^\d{4}$/.test(y) ? y : null;
}

/** An income category is exempt · natural · other · unsure. */
export async function setTaxClass(formData: FormData) {
  await treasurer();
  const year = yearOf(formData);
  const code = String(formData.get("code") ?? "");
  const cls = String(formData.get("tax_class") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_tax_class", { p_code: code, p_class: cls });
  if (error) back(year, `error=${encodeURIComponent(error.message)}`);
  refresh();
  back(year, "ok=class");
}

/** An incoming bank line that is not a member payment gets its income category (or none). */
export async function setBankCategory(formData: FormData) {
  await treasurer();
  const year = yearOf(formData);
  const txId = String(formData.get("tx_id") ?? "");
  const code = String(formData.get("category_code") ?? "").trim();
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_bank_tx_category", { p_tx_id: txId, p_code: code || null });
  if (error) back(year, `error=${encodeURIComponent(error.message)}`);
  refresh();
  back(year, code ? "ok=sorted" : "ok=unsorted");
}

/** Income that is in neither the app nor the bank statement (cash at a fair, say). */
export async function addIncomeEntry(formData: FormData) {
  await treasurer();
  const year = yearOf(formData);
  const date = String(formData.get("booked_on") ?? "");
  const amount = Number(String(formData.get("amount_sek") ?? "").replace(",", "."));
  const code = String(formData.get("category_code") ?? "");
  const note = String(formData.get("note") ?? "");
  if (!isValidISODate(date)) back(year, "error=" + encodeURIComponent("Enter the date"));
  if (!Number.isFinite(amount) || amount <= 0) back(year, "error=" + encodeURIComponent("Enter the amount in kronor"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_income_entry", { p_date: date, p_amount: amount, p_code: code, p_note: note });
  if (error) back(year, `error=${encodeURIComponent(error.message)}`);
  refresh();
  back(year, "ok=entry");
}

export async function deleteIncomeEntry(formData: FormData) {
  await treasurer();
  const year = yearOf(formData);
  const id = String(formData.get("id") ?? "");
  const supabase = await createClient();
  const { error } = await supabase.rpc("delete_income_entry", { p_id: id });
  if (error) back(year, `error=${encodeURIComponent(error.message)}`);
  refresh();
  back(year, "ok=entry_removed");
}

/** Yellow threshold and the month the financial year starts. */
export async function saveTaxSettings(formData: FormData) {
  await treasurer();
  const year = yearOf(formData);
  const warn = Number(formData.get("tax_warn_pct"));
  const month = Number(formData.get("tax_year_start_month"));
  if (!Number.isInteger(warn) || warn < 1 || warn > 25) back(year, "error=" + encodeURIComponent("The warning level is 1–25 %"));
  if (!Number.isInteger(month) || month < 1 || month > 12) back(year, "error=" + encodeURIComponent("Choose a month"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_tax_settings", { p_warn_pct: warn, p_start_month: month });
  if (error) back(year, `error=${encodeURIComponent(error.message)}`);
  refresh();
  back(year, "ok=settings");
}
