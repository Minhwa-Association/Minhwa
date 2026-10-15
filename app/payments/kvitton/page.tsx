import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { shortDate } from "@/lib/dates";
import { issueMissingReceipts, saveReceiptDrive, syncKvitton } from "@/app/actions";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { fileUrl, folderUrl } from "@/lib/drive-links";
import { driveConfigured, KVITTON_FOLDER, ROOT_FOLDER } from "@/lib/drive";
import { KIND_WORD, money, paidWith, type SalesReceipt } from "@/lib/receipts";

type Q = { error?: string; ok?: string; n?: string; note?: string; all?: string };
type Row = Pick<SalesReceipt, "id" | "number" | "payment_id" | "member_name" | "kind" | "payment_code" | "title" | "description" | "total_sek" | "swish_sek" | "credit_sek" | "paid_on" | "issued_at" | "voided_at" | "void_reason" | "drive_file_id" | "drive_saved_at">;
const ROW = "id, number, payment_id, member_name, kind, payment_code, title, description, total_sek, swish_sek, credit_sek, paid_on, issued_at, voided_at, void_reason, drive_file_id, drive_saved_at";

function okText(q: Q): string | undefined {
  if (q.ok === "kvitton_synced") return `${q.n ?? 0} receipt${q.n === "1" ? "" : "s"} saved to Google Drive.${q.note ? ` One failed: ${q.note}` : ""}`;
  if (q.ok === "kvitton_issued") return Number(q.n ?? 0) === 0 ? "Every paid payment already has its receipt." : `${q.n} receipt${q.n === "1" ? "" : "s"} issued.`;
  if (q.ok === "kvitto_saved") return "Saved to Google Drive.";
  return undefined;
}

/** Payments → Kvitton — every receipt the app has issued, and whether its PDF is in the association's Drive (v17). */
export default async function KvittonPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  const q = await searchParams;
  const showAll = q.all === "1";
  const supabase = await createClient();
  const [{ data: rows }, { count: nMissing }, { count: nTotal }, { count: nLive }, { data: driveRows }, { count: nConfirmed }] = await Promise.all([
    supabase.from("sales_receipts").select(ROW).order("issued_at", { ascending: false }).limit(showAll ? 1000 : 60),
    supabase.from("sales_receipts").select("id", { count: "exact", head: true }).is("drive_file_id", null).is("voided_at", null),
    supabase.from("sales_receipts").select("id", { count: "exact", head: true }),
    supabase.from("sales_receipts").select("id", { count: "exact", head: true }).is("voided_at", null),
    supabase.rpc("drive_status"),
    supabase.from("payments").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
  ]);
  const list = (rows ?? []) as Row[];
  const driveRow = ((Array.isArray(driveRows) ? driveRows[0] : driveRows) ?? null) as { connected: boolean; kvitton_folder_id: string | null } | null;
  const drive = driveRow?.connected ? driveRow : null;
  const liveCount = list.filter((r) => !r.voided_at).length;
  const missing = nMissing ?? 0;
  const staleVoid = list.filter((r) => r.voided_at && r.drive_saved_at && r.voided_at > r.drive_saved_at).length;
  // paid payments with no receipt (issuing failed): confirmed payments minus live receipts — a refunded payment keeps its receipt, so never below 0
  const withoutReceipt = Math.max(0, (nConfirmed ?? 0) - (nLive ?? 0));

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Kvitton</h1><div className="muted small">Receipts issued to members for what they paid · one per paid seat, pass or order · <Link href="/payments">← Payments</Link></div></div>
        <TopNav current="payments" me={me} />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Notice error={q.error} ok={q.ok} text={okText(q)} />

        <div className="card stack" style={{ padding: 18, gap: 10 }}>
          <div className="muted small">
            A receipt (kvitto) is made the moment a payment becomes <b>Paid</b> — when you confirm it here, or at once when credits covered it. Numbers run K{new Date().getFullYear()}-0001, 0002 … with no gaps; a confirmation taken back makes its receipt void (the number stays). Each PDF goes to the association&apos;s Google Drive, &ldquo;{ROOT_FOLDER} / {KVITTON_FOLDER}&rdquo;.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="small"><b>{nTotal ?? 0}</b> receipt{(nTotal ?? 0) === 1 ? "" : "s"} · <b>{missing}</b> not in Drive yet{staleVoid > 0 ? ` · ${staleVoid} void since saved` : ""}</span>
            {!driveConfigured() ? <span className="muted small">Google Drive is not set up (see Settings).</span>
              : !drive ? <span className="muted small">Google Drive is not connected — an admin connects it in Settings.</span>
              : (
                <>
                  {drive.kvitton_folder_id && <a href={folderUrl(drive.kvitton_folder_id)} target="_blank" rel="noopener noreferrer" className="btn line sm">Open the Kvitton folder</a>}
                  {(missing > 0 || staleVoid > 0) && <form action={syncKvitton}><SubmitButton className="btn ink sm" pendingText="Saving…">Save {missing + staleVoid} to Drive</SubmitButton></form>}
                </>
              )}
            <form action={issueMissingReceipts}><SubmitButton className={`btn ${withoutReceipt > 0 ? "line" : "quiet"} sm`} pendingText="Issuing…">{withoutReceipt > 0 ? `Issue ${withoutReceipt} missing receipt${withoutReceipt === 1 ? "" : "s"}` : "Issue missing receipts"}</SubmitButton></form>
          </div>
        </div>

        <section className="card stack paysect" style={{ padding: 18 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2>{showAll ? "All receipts" : "Latest receipts"} <span className="count">{liveCount}</span></h2>
            {!showAll && (nTotal ?? 0) > list.length && <Link href="/payments/kvitton?all=1" className="btn quiet sm">Show all {nTotal}</Link>}
          </div>
          <div className="stack" style={{ gap: 0 }}>
            {list.length === 0 && <div className="muted small">No receipts yet — the first one comes with the first confirmed payment.</div>}
            {list.map((r) => (
              <div key={r.id} className={`txrow ${r.voided_at ? "voided" : ""}`}>
                <div className="muted small">{shortDate(new Date(r.paid_on))}</div>
                <div style={{ minWidth: 0 }}>
                  <div>
                    <b>{r.number}</b>{r.voided_at ? <span className="tag unpaid" style={{ marginLeft: 6 }}>void</span> : null}
                    <span className="muted"> · {r.member_name} · {KIND_WORD[r.kind] ?? r.kind} · {r.description}</span>
                    {r.payment_code && <> <span className="tag code">{r.payment_code}</span></>}
                  </div>
                  <div className="muted small">
                    {paidWith(r)}
                    {r.drive_file_id ? ` · in Drive ${r.drive_saved_at?.slice(0, 10) ?? ""}` : " · not in Drive"}
                    {r.voided_at ? ` · void ${r.voided_at.slice(0, 10)}${r.void_reason ? ` (${r.void_reason})` : ""}` : ""}
                  </div>
                </div>
                <div className="amt">{money(r.total_sek)}</div>
                <div className="actions">
                  <Link href={`/receipt/${r.id}?from=k`} className="btn line sm">Open</Link>
                  <a href={`/api/receipt/${r.id}/pdf`} target="_blank" rel="noopener noreferrer" className="btn quiet sm">PDF</a>
                  {r.drive_file_id && <a href={fileUrl(r.drive_file_id)} target="_blank" rel="noopener noreferrer" className="btn quiet sm">Drive</a>}
                  {drive && (!r.drive_file_id || (r.voided_at && r.drive_saved_at && r.voided_at > r.drive_saved_at)) && (
                    <form action={saveReceiptDrive}>
                      <input type="hidden" name="receipt_id" value={r.id} />
                      <input type="hidden" name="back" value={`/payments/kvitton${showAll ? "?all=1" : ""}`} />
                      <SubmitButton className="btn line sm" pendingText="Saving…">Save to Drive</SubmitButton>
                    </form>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
