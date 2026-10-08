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

/** Text for the notice after a cancellation — says who got the seat when the waiting list took it. */
export function cancelledText(to?: string | null): string {
  return to ? `Booking cancelled. Your seat went to ${to} from the waiting list.` : "Booking cancelled.";
}

/** Text for the notice after the admin removed a booking. */
export function removedText(to?: string | null): string {
  return to ? `Booking removed — the seat went to ${to} from the waiting list.` : "Booking removed.";
}
