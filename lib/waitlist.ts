/** A live row of the waiting list (status = 'waiting'); the order is created_at. */
export type WaitRow = {
  id: string;
  member_id: string;
  slot_id: string;
  date: string;
  created_at: string;
};

/** 1-based place in the list for one member of one session (0 = not on it). */
export function waitPosition<T extends { member_id: string; slot_id: string; date: string; created_at: string }>(rows: T[], memberId: string, slotId: string, date: string): number {
  const list = rows.filter((w) => w.slot_id === slotId && w.date === date).sort(byCreated);
  const i = list.findIndex((w) => w.member_id === memberId);
  return i < 0 ? 0 : i + 1;
}

export function byCreated(a: { created_at: string }, b: { created_at: string }): number {
  return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
}

/** "#2" */
export function ordinal(n: number): string {
  return `#${n}`;
}

/** v16.2: what a cancelled seat gives back — credits now (cr) and credits once the treasurer sees the money (later). */
function creditsBackText(cr?: string | number | null, later?: string | number | null, who = "you"): string {
  const now = Number(cr) || 0, after = Number(later) || 0;
  const parts: string[] = [];
  if (now > 0) parts.push(who === "you"
    ? `${now} credit${now === 1 ? " is" : "s are"} back on your account (1 credit = 1 kr) — use them for your next seat or in the Store.`
    : `${now} credit${now === 1 ? "" : "s"} went back to the member.`);
  if (after > 0) parts.push(who === "you"
    ? `The ${after} kr you sent comes back as credits once the treasurer sees it in the bank.`
    : `The ${after} kr they sent becomes credits once it is confirmed in Payments.`);
  return parts.join(" ");
}

/** Text for the notice after a cancellation — what comes back, and who got the seat from the waiting list. */
export function cancelledText(to?: string | null, cr?: string | number | null, later?: string | number | null): string {
  return ["Booking cancelled.", creditsBackText(cr, later), to ? `Your seat went to ${to} from the waiting list.` : ""].filter(Boolean).join(" ");
}

/** Text for the notice after the admin removed a booking. */
export function removedText(to?: string | null, cr?: string | number | null, later?: string | number | null): string {
  return [to ? `Booking removed — the seat went to ${to} from the waiting list.` : "Booking removed.", creditsBackText(cr, later, "member")].filter(Boolean).join(" ");
}
