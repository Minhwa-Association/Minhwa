import Link from "next/link";
import { signOut } from "@/app/actions";

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

export function TopNav({ current, isAdmin }: { current: "board" | "me" | "admin"; isAdmin: boolean }) {
  return (
    <nav className="nav" aria-label="Main">
      <Link href="/" className={`pill ${current === "board" ? "active" : ""}`}>Board</Link>
      <Link href="/me" className={`pill ${current === "me" ? "active" : ""}`}>My seats</Link>
      {isAdmin && <Link href="/admin" className={`pill ${current === "admin" ? "active" : ""}`}>Admin</Link>}
      <form action={signOut}><button className="pill" style={{ cursor: "pointer" }}>Log out</button></form>
    </nav>
  );
}

export function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (error) return <div className="notice err" role="alert">{error}</div>;
  if (ok === "cancelled") return <div className="notice ok">Booking cancelled.</div>;
  if (ok === "paid") return <div className="notice ok">Thanks — marked as awaiting confirmation. An admin will confirm your payment.</div>;
  if (ok === "saved") return <div className="notice ok">Saved.</div>;
  return null;
}

export function ChargeTag({ status, extra }: { status?: string | null; extra?: boolean }) {
  if (extra) return <span className="tag extra">Extra seat</span>;
  if (status === "paid") return <span className="tag paid"><Check /> Paid</span>;
  if (status === "pending") return <span className="tag pending">Awaiting confirmation</span>;
  if (status === "unpaid") return <span className="tag unpaid">Not paid yet</span>;
  return null;
}
