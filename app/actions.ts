"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUseCalendar, cleanRoles, hasRole } from "@/lib/roles";
import { isValidISODate } from "@/lib/dates";
import { keyToAudience } from "@/lib/calendar";

function backWithError(path: string, message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}error=${encodeURIComponent(message)}`);
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
  redirect(`${back}${back.includes("?") ? "&" : "?"}ok=cancelled`);
}

export async function markPending(formData: FormData) {
  const chargeId = String(formData.get("charge_id"));
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_pending", { p_charge_id: chargeId });
  if (error) backWithError("/me", error.message);
  revalidatePath("/me");
  redirect("/me?ok=paid");
}

export async function confirmPaid(formData: FormData) {
  const chargeId = String(formData.get("charge_id"));
  const back = String(formData.get("back") || "/admin");
  const supabase = await createClient();
  const { error } = await supabase.rpc("confirm_paid", { p_charge_id: chargeId });
  if (error) backWithError(back, error.message);
  revalidatePath("/admin");
  redirect(back);
}

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
