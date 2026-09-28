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

/** Tabs follow the roles: everyone Board · My seats · Store; Crew/Admin + Calendar; Treasurer/Admin + Payments; Admin + Admin. */
export function TopNav({ current, me }: { current: "board" | "me" | "store" | "calendar" | "payments" | "admin"; me: Me }) {
  const pill = (key: typeof current) => `pill ${current === key ? "active" : ""}`;
  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" className={pill("board")}>Board</Link>
      <Link href="/me" className={pill("me")}>My seats</Link>
      <Link href="/store" className={pill("store")}>Store</Link>
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
  if (ok === "order_paid") return <div className="notice ok">Thanks — marked as awaiting confirmation. The treasurer confirms it when it shows up in the bank, then prepares your items.</div>;
  if (ok === "order_cancelled") return <div className="notice ok">Order cancelled.</div>;
  if (ok === "product_added") return <div className="notice ok">Product added.</div>;
  if (ok === "stock") return <div className="notice ok">Stock updated.</div>;
  if (ok === "handed") return <div className="notice ok">Taken from stock — the member sees it as ready to collect.</div>;
  if (ok === "collected") return <div className="notice ok">Marked as collected.</div>;
  if (ok === "batch_started") return <div className="notice ok">Group order started. Put the waiting lines on it and add restock.</div>;
  if (ok === "batch_line") return <div className="notice ok">Line put on the group order.</div>;
  if (ok === "batch_ordered") return <div className="notice ok">Marked as ordered — the list is frozen. Tick &ldquo;Arrived&rdquo; when the boxes are here.</div>;
  if (ok === "batch_arrived") return <div className="notice ok">Arrived — stock booked in, members&apos; items are ready to collect.</div>;
  if (ok === "refunded") return <div className="notice ok">Line marked as refunded.</div>;
  if (ok === "requested") return <div className="notice ok">Request sent — the treasurer will look at it and you will see the answer here.</div>;
  if (ok === "quoted") return <div className="notice ok">Quote sent — the member now has an order to pay under My orders. Once paid it goes on the group order like any other line.</div>;
  if (ok === "linked") return <div className="notice ok">Linked to the member — mails from that address will find them from now on.</div>;
  if (ok === "approved") return <div className="notice ok">Approved. Pay it from the bank, then tick it here — or paste the statement and the line is found for you.</div>;
  if (ok === "declined") return <div className="notice ok">Declined — the member sees your reply in the app.</div>;
  if (ok === "reopened") return <div className="notice ok">Back in the list to check.</div>;
  if (ok === "claim_paid") return <div className="notice ok">Marked as paid.</div>;
  if (ok === "claim_unpaid") return <div className="notice ok">Taken back — the claim is approved and waiting for its payment again.</div>;
  if (ok === "acked") return <div className="notice ok">&ldquo;Received&rdquo; reply sent to the member.</div>;
  if (ok === "ack_skipped") return <div className="notice ok">No reply sent — it was already sent, or the claim has no member or no sending address.</div>;
  if (ok === "account_saved") return <div className="notice ok">Bank account saved. The treasurer sees it only when paying you back.</div>;
  if (ok === "emails_saved") return <div className="notice ok">Addresses saved — receipts sent from them will be yours.</div>;
  if (ok === "receipt_sent") return <div className="notice ok">Receipt sent to the treasurer. You will see the answer here.</div>;
  if (ok === "withdrawn") return <div className="notice ok">Receipt taken back.</div>;
  if (ok === "credits_used") return <div className="notice ok">Credits used.</div>;
  if (ok === "credits_released") return <div className="notice ok">Credits taken off — they are back in your balance. Pay the whole amount with Swish.</div>;
  if (ok === "credits_given") return <div className="notice ok">Credits given.</div>;
  if (ok === "credits_adjusted") return <div className="notice ok">Balance corrected.</div>;
  if (ok === "credits_voided") return <div className="notice ok">Credits taken back.</div>;
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
