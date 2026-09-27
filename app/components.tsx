import Link from "next/link";
import { signOut } from "@/app/actions";
import { canUseCalendar, canUsePayments, hasRole } from "@/lib/roles";
import { paymentLabel, paymentClass } from "@/lib/payments";

export function Chevron({ dir }: { dir: "left" | "right" }) {
  const points = dir === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6";
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={points} />
    </svg>
  );
}

export function Check() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

type Me = { roles?: string[] | null } | null | undefined;

/** Tabs follow the roles: everyone Board · My seats; Crew/Admin + Calendar; Treasurer/Admin + Payments; Admin + Admin. */
export function TopNav({ current, me }: { current: "board" | "me" | "calendar" | "payments" | "admin"; me: Me }) {
  const pill = (key: typeof current) => `pill ${current === key ? "active" : ""}`;
  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" className={pill("board")}>Board</Link>
      <Link href="/me" className={pill("me")}>My seats</Link>
      {canUseCalendar(me) && <Link href="/calendar" className={pill("calendar")}>Calendar</Link>}
      {canUsePayments(me) && <Link href="/payments" className={pill("payments")}>Payments</Link>}
      {hasRole(me, "admin") && <Link href="/admin" className={pill("admin")}>Admin</Link>}
      <form action={signOut}><button className="pill" style={{ cursor: "pointer" }}>Log out</button></form>
    </nav>
  );
}

export function Notice({ error, ok, text }: { error?: string; ok?: string; text?: string }) {
  if (error) return <div className="notice err" role="alert">{error}</div>;
  if (text) return <div className="notice ok">{text}</div>;
  if (ok === "cancelled") return <div className="notice ok">Booking cancelled.</div>;
  if (ok === "paid") return <div className="notice ok">Thanks — marked as awaiting confirmation. The treasurer confirms it when it shows up in the bank.</div>;
  if (ok === "saved") return <div className="notice ok">Saved.</div>;
  if (ok === "event_saved") return <div className="notice ok">Event saved.</div>;
  if (ok === "event_deleted") return <div className="notice ok">Event deleted.</div>;
  if (ok === "link_reset") return <div className="notice ok">New link created. The old link no longer works — add the new one to your phone.</div>;
  if (ok === "confirmed") return <div className="notice ok">Payment confirmed.</div>;
  if (ok === "undone") return <div className="notice ok">Confirmation taken back — the payment is waiting again.</div>;
  if (ok === "rejected") return <div className="notice ok">Suggestion removed — the bank line is waiting again.</div>;
  if (ok === "ignored") return <div className="notice ok">Bank line set aside.</div>;
  if (ok === "restored") return <div className="notice ok">Bank line is back in the waiting list.</div>;
  return null;
}

/** Payment status pill on the roster and My seats. */
export function PaymentTag({ status, extra }: { status?: string | null; extra?: boolean }) {
  if (extra) return <span className="tag extra">Extra seat</span>;
  const cls = paymentClass(status);
  if (status === "confirmed") return <span className="tag paid"><Check /> Paid</span>;
  if (status === "claimed") return <span className={`tag ${cls}`}>{paymentLabel(status)}</span>;
  if (status === "pending") return <span className="tag unpaid">{paymentLabel(status)}</span>;
  return null;
}
