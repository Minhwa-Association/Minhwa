/**
 * Google Drive — the association's copies (v16.4 receipts to pay back, v17 kvitton).
 *
 * The admin connects once in Settings, signed in as manager@minhwa.org (OAuth, "drive.file": the app may only
 * touch files and folders it made itself). Google's lasting key (refresh token) is kept in drive_connection,
 * encrypted here with a key made from GOOGLE_CLIENT_SECRET. Approving a receipt saves its files to
 * "Minhwa — Bokföring / Receipts"; declining moves them to Drive's bin. A payment becoming "Paid" puts the
 * member's receipt (kvitto) as a PDF in "Minhwa — Bokföring / Kvitton".
 *
 * Server only — never import this from a client component.
 */
import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { RECEIPTS_BUCKET, type ClaimRow } from "@/lib/claims";
import { RECEIPT_SELECT, receiptFileName as kvittoFileName, type SalesReceipt } from "@/lib/receipts";

// GOOGLE_TEST_ORIGIN points everything at a fake Google — for tests only; never set it in Vercel.
const TEST = process.env.GOOGLE_TEST_ORIGIN;
const AUTH_URL = TEST ? `${TEST}/o/oauth2/v2/auth` : "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = TEST ? `${TEST}/token` : "https://oauth2.googleapis.com/token";
const API = TEST ? `${TEST}/drive/v3` : "https://www.googleapis.com/drive/v3";
const UPLOAD = TEST ? `${TEST}/upload/drive/v3` : "https://www.googleapis.com/upload/drive/v3";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
export const DRIVE_ACCOUNT = "manager@minhwa.org";
export const ROOT_FOLDER = "Minhwa — Bokföring";
export const RECEIPTS_FOLDER = "Receipts";
export const KVITTON_FOLDER = "Kvitton";
const FOLDER_TYPE = "application/vnd.google-apps.folder";

export class DriveError extends Error {}

export function driveConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

export { fileUrl, folderUrl } from "@/lib/drive-links";
export function callbackUrl(origin: string): string { return `${origin}/api/google/callback`; }

/** The address the browser used (https://app.minhwa.org) — not the server's own host name behind the proxy. */
export function requestOrigin(req: { headers: Headers; nextUrl: URL }): string {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? req.nextUrl.host;
  const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(/:$/, "");
  return `${proto.split(",")[0].trim()}://${host.split(",")[0].trim()}`;
}

// ───────────── the key at rest ─────────────
function sealKey(): Buffer {
  return crypto.createHash("sha256").update(`minhwa-drive-token:${process.env.GOOGLE_CLIENT_SECRET ?? ""}`).digest();
}
export function sealToken(token: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", sealKey(), iv);
  const body = Buffer.concat([c.update(token, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), body.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
}
export function openToken(sealed: string): string | null {
  try {
    const [v, iv, body, tag] = sealed.split(".");
    if (v !== "v1") return null;
    const d = crypto.createDecipheriv("aes-256-gcm", sealKey(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

// ───────────── signing in ─────────────
export function authUrl(redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID ?? "",
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `openid email ${DRIVE_SCOPE}`,
    access_type: "offline",
    prompt: "consent",            // always hand out the lasting key
    include_granted_scopes: "true",
    login_hint: DRIVE_ACCOUNT,
    hd: "minhwa.org",
    state,
  });
  return `${AUTH_URL}?${p}`;
}

type TokenAnswer = { access_token?: string; refresh_token?: string; id_token?: string; error?: string; error_description?: string };

async function tokenCall(form: Record<string, string>): Promise<TokenAnswer> {
  const r = await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form), cache: "no-store" });
  const j = (await r.json().catch(() => ({}))) as TokenAnswer;
  if (!r.ok || !j.access_token) {
    if (j.error === "invalid_grant") throw new DriveError("Google no longer accepts the saved connection — reconnect Google Drive in Settings.");
    throw new DriveError(`Google sign-in failed (${j.error_description ?? j.error ?? r.status}).`);
  }
  return j;
}

/** code from the callback → the keys and the account's address */
export async function exchangeCode(code: string, redirectUri: string): Promise<{ accessToken: string; refreshToken: string | null; email: string | null }> {
  const j = await tokenCall({
    code, redirect_uri: redirectUri, grant_type: "authorization_code",
    client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  });
  let email: string | null = null;
  try { email = (JSON.parse(Buffer.from((j.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string }).email ?? null; } catch { /* no id token */ }
  return { accessToken: j.access_token!, refreshToken: j.refresh_token ?? null, email };
}

async function accessToken(refreshToken: string): Promise<string> {
  const j = await tokenCall({
    refresh_token: refreshToken, grant_type: "refresh_token",
    client_id: process.env.GOOGLE_CLIENT_ID ?? "", client_secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  });
  return j.access_token!;
}

// ───────────── Drive calls ─────────────
async function gjson<T>(token: string, url: string, init: RequestInit = {}): Promise<{ status: number; body: T | null }> {
  const r = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) }, cache: "no-store" });
  const body = (await r.json().catch(() => null)) as T | null;
  if (!r.ok && r.status !== 404) {
    const msg = (body as { error?: { message?: string } } | null)?.error?.message;
    throw new DriveError(`Google Drive said ${r.status}${msg ? `: ${msg}` : ""}`);
  }
  return { status: r.status, body };
}

async function folderAlive(token: string, id: string | null | undefined): Promise<boolean> {
  if (!id) return false;
  const { status, body } = await gjson<{ trashed?: boolean }>(token, `${API}/files/${encodeURIComponent(id)}?fields=id,trashed`);
  return status !== 404 && !body?.trashed;
}

async function makeFolder(token: string, name: string, parent?: string): Promise<string> {
  const { body } = await gjson<{ id: string }>(token, `${API}/files?fields=id`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_TYPE, ...(parent ? { parents: [parent] } : {}) }),
  });
  if (!body?.id) throw new DriveError("Google Drive did not make the folder.");
  return body.id;
}

export type Folders = { root: string; receipts: string; kvitton: string; changed: boolean };

/** "Minhwa — Bokföring / Receipts" and "/ Kvitton" — the ones we know if they still exist, otherwise new ones */
export async function ensureFolders(token: string, root?: string | null, receipts?: string | null, kvitton?: string | null): Promise<Folders> {
  let changed = false;
  let r = root ?? null, rc = receipts ?? null, kv = kvitton ?? null;
  if (!(await folderAlive(token, r))) { r = await makeFolder(token, ROOT_FOLDER); rc = null; kv = null; changed = true; }
  if (!(await folderAlive(token, rc))) { rc = await makeFolder(token, RECEIPTS_FOLDER, r!); changed = true; }
  if (!(await folderAlive(token, kv))) { kv = await makeFolder(token, KVITTON_FOLDER, r!); changed = true; }
  return { root: r!, receipts: rc!, kvitton: kv!, changed };
}

async function uploadFile(token: string, name: string, parent: string, bytes: Buffer | Uint8Array, contentType: string, description: string): Promise<string> {
  const boundary = `minhwa${crypto.randomBytes(8).toString("hex")}`;
  const meta = JSON.stringify({ name, parents: [parent], description });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, "utf8"),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  const { body: j } = await gjson<{ id: string }>(token, `${UPLOAD}/files?uploadType=multipart&fields=id`, {
    method: "POST", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  if (!j?.id) throw new DriveError("Google Drive did not take the file.");
  return j.id;
}

/** replace the bytes of a file we put there; false when it is gone or in the bin */
async function updateFile(token: string, id: string, name: string, bytes: Buffer | Uint8Array, contentType: string): Promise<boolean> {
  const boundary = `minhwa${crypto.randomBytes(8).toString("hex")}`;
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name })}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`, "utf8"),
    Buffer.from(bytes),
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);
  const { status, body: j } = await gjson<{ trashed?: boolean }>(token, `${UPLOAD}/files/${encodeURIComponent(id)}?uploadType=multipart&fields=id,trashed`, {
    method: "PATCH", headers: { "Content-Type": `multipart/related; boundary=${boundary}` }, body,
  });
  return status !== 404 && !j?.trashed;
}

/** rename a file we put there; false when it is gone or in the bin */
async function renameFile(token: string, id: string, name: string): Promise<boolean> {
  const { status, body } = await gjson<{ trashed?: boolean }>(token, `${API}/files/${encodeURIComponent(id)}?fields=id,trashed`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
  });
  return status !== 404 && !body?.trashed;
}

async function trashFile(token: string, id: string): Promise<void> {
  await gjson(token, `${API}/files/${encodeURIComponent(id)}?fields=id`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ trashed: true }),
  });
}

// ───────────── the connection ─────────────
export type DriveResult = { state: "saved" | "off" | "failed"; saved: number; message?: string };

type Conn = { email: string; token_enc: string; root_folder_id: string | null; receipts_folder_id: string | null; kvitton_folder_id: string | null };

/** The lasting key turned into a fresh access token, and the folders. Works for the treasurer/admin's own
 *  client and for the app's service client (a member paying with credits confirms with no treasurer around). */
async function connection(supabase: SupabaseClient): Promise<{ token: string; folders: Folders } | null> {
  if (!driveConfigured()) return null;
  const { data } = await supabase.rpc("drive_token");
  const conn = (Array.isArray(data) ? data[0] : data) as Conn | undefined;
  if (!conn) return null;
  const refresh = openToken(conn.token_enc);
  if (!refresh) throw new DriveError("The saved Google connection can't be read (the Google secret changed?) — reconnect Google Drive in Settings.");
  const token = await accessToken(refresh);
  const folders = await ensureFolders(token, conn.root_folder_id, conn.receipts_folder_id, conn.kvitton_folder_id);
  if (folders.changed) {
    const { error } = await supabase.rpc("drive_set_folders", { p_root: folders.root, p_receipts: folders.receipts, p_kvitton: folders.kvitton });
    if (error) throw new DriveError(error.message);
  }
  return { token, folders };
}

// ───────────── receipts to pay back (v16.4) ─────────────
const CATEGORY_WORD: Record<string, string> = {
  material: "Material", venue: "Venue", fika: "Fika", fee: "Fee", other: "Other", loan: "Loan",
  membership: "Membership", course: "Course", seat: "Seat", material_sale: "Material sale", grant: "Grant",
};
const EXT: Record<string, string> = {
  "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/heic": ".heic", "image/heif": ".heif",
  "application/pdf": ".pdf", "text/html": ".html", "text/plain": ".txt",
};

type DriveClaim = Pick<ClaimRow, "code" | "status" | "purchased_on" | "received_at" | "category_code" | "member_name" | "sender_name" | "approved_amount_sek" | "amount_sek" | "merchant">;
type DriveFile = { id: string; path: string; filename: string | null; content_type: string | null; sort: number; drive_file_id: string | null };

function stockholmDay(iso: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

/** "2026-10-15 R0012 Material — Julien Petotte 450 kr.jpg" (+ " (2)" for the second file of the same receipt) */
export function receiptFileName(c: DriveClaim, f: Pick<DriveFile, "filename" | "content_type">, index: number, count: number): string {
  const day = c.purchased_on ?? stockholmDay(c.received_at);
  const word = CATEGORY_WORD[c.category_code ?? ""] ?? (c.category_code ? c.category_code.replace(/_/g, " ") : "Receipt");
  const who = c.member_name ?? c.sender_name ?? "Unknown";
  const n = Number(c.approved_amount_sek ?? c.amount_sek ?? 0);
  const amount = Number.isInteger(n) ? String(n) : n.toFixed(2);
  const fromName = (f.filename ?? "").match(/\.[A-Za-z0-9]{2,5}$/)?.[0]?.toLowerCase();
  const ext = (fromName === ".jpeg" ? ".jpg" : fromName) ?? EXT[f.content_type ?? ""] ?? "";
  const base = `${day} ${c.code} ${word} — ${who} ${amount} kr${count > 1 && index > 0 ? ` (${index + 1})` : ""}`;
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/\s+/g, " ").trim() + ext;
}

/** Approved or paid receipt → its files in Drive (new ones uploaded, ones already there renamed). */
export async function saveClaimToDrive(supabase: SupabaseClient, claimId: string): Promise<DriveResult> {
  try {
    const conn = await connection(supabase);
    if (!conn) return { state: "off", saved: 0 };
    const [{ data: claim, error: e1 }, { data: fileRows, error: e2 }] = await Promise.all([
      supabase.from("claims_view").select("code, status, purchased_on, received_at, category_code, member_name, sender_name, approved_amount_sek, amount_sek, merchant").eq("id", claimId).single(),
      supabase.from("claim_files").select("id, path, filename, content_type, sort, drive_file_id").eq("claim_id", claimId).order("sort"),
    ]);
    if (e1 || !claim) throw new DriveError(e1?.message ?? "Receipt not found");
    if (e2) throw new DriveError(e2.message);
    const c = claim as DriveClaim;
    if (c.status !== "approved" && c.status !== "paid") return { state: "saved", saved: 0 };
    const files = (fileRows ?? []) as DriveFile[];
    let saved = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const name = receiptFileName(c, f, i, files.length);
      if (f.drive_file_id && (await renameFile(conn.token, f.drive_file_id, name))) continue;   // already there
      const { data: blob, error } = await supabase.storage.from(RECEIPTS_BUCKET).download(f.path);
      if (error || !blob) throw new DriveError(`Could not read ${f.filename ?? "the file"} from the app: ${error?.message ?? "empty"}`);
      const bytes = Buffer.from(await blob.arrayBuffer());
      const desc = `${c.code} · ${c.member_name ?? c.sender_name ?? ""}${c.merchant ? ` · ${c.merchant}` : ""} · approved in app.minhwa.org`;
      const id = await uploadFile(conn.token, name, conn.folders.receipts, bytes, f.content_type || blob.type || "application/octet-stream", desc);
      const { error: e3 } = await supabase.rpc("claim_file_in_drive", { p_file_id: f.id, p_drive_id: id });
      if (e3) throw new DriveError(e3.message);
      saved++;
    }
    return { state: "saved", saved };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[drive] save ${claimId}: ${message}`);
    return { state: "failed", saved: 0, message };
  }
}

/** Declined after it was in Drive → the files go to Drive's bin (best effort). */
export async function removeClaimFromDrive(supabase: SupabaseClient, claimId: string): Promise<void> {
  try {
    const { data: fileRows } = await supabase.from("claim_files").select("id, drive_file_id").eq("claim_id", claimId).not("drive_file_id", "is", null);
    const files = (fileRows ?? []) as { id: string; drive_file_id: string }[];
    if (files.length === 0) return;
    const conn = await connection(supabase);
    if (!conn) return;
    for (const f of files) {
      await trashFile(conn.token, f.drive_file_id);
      await supabase.rpc("claim_file_in_drive", { p_file_id: f.id, p_drive_id: null });
    }
  } catch (e) {
    console.error(`[drive] remove ${claimId}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// ───────────── kvitton (v17) ─────────────
/** One receipt's PDF into "Minhwa — Bokföring / Kvitton". Already there → the file is written again under its
 *  current name (so a void shows in Drive too). */
async function putReceipt(supabase: SupabaseClient, conn: { token: string; folders: Folders }, r: SalesReceipt): Promise<"uploaded" | "updated"> {
  // v19.3: the PDF maker (pdf-lib + fonts, ~1 MB) is loaded only here, when a receipt is actually made —
  // not on every page start (every page's Log out button pulls in app/actions.ts, which imports this file)
  const { receiptPdf } = await import("@/lib/receipt-pdf");
  const pdf = await receiptPdf(r);
  const name = kvittoFileName(r);
  if (r.drive_file_id && (await updateFile(conn.token, r.drive_file_id, name, pdf, "application/pdf"))) return "updated";
  const desc = `${r.number} · ${r.member_name} · ${r.title} · ${r.description}${r.payment_code ? ` · ${r.payment_code}` : ""} · issued by app.minhwa.org`;
  const id = await uploadFile(conn.token, name, conn.folders.kvitton, pdf, "application/pdf", desc);
  const { error } = await supabase.rpc("sales_receipt_in_drive", { p_id: r.id, p_drive_id: id });
  if (error) throw new DriveError(error.message);
  return "uploaded";
}

/** This receipt → Drive (again). "Save to Drive" on Payments → Kvitton. */
export async function saveSalesReceiptToDrive(supabase: SupabaseClient, receiptId: string): Promise<DriveResult> {
  try {
    const conn = await connection(supabase);
    if (!conn) return { state: "off", saved: 0 };
    const { data, error } = await supabase.from("sales_receipts").select(RECEIPT_SELECT).eq("id", receiptId).single();
    if (error || !data) throw new DriveError(error?.message ?? "Receipt not found");
    await putReceipt(supabase, conn, data as SalesReceipt);
    return { state: "saved", saved: 1 };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[drive] kvitto ${receiptId}: ${message}`);
    return { state: "failed", saved: 0, message };
  }
}

/**
 * Every receipt not yet in Drive → Drive, and every receipt made void since it went there → written again
 * with the VOID stamp. Called after a confirmation (in the background) and from Payments → Kvitton.
 * Best effort: one failure does not stop the others; the result says how many went.
 */
export async function syncSalesReceiptsToDrive(supabase: SupabaseClient): Promise<DriveResult> {
  try {
    const conn = await connection(supabase);
    if (!conn) return { state: "off", saved: 0 };
    const [{ data: missing, error: e1 }, { data: voided, error: e2 }] = await Promise.all([
      supabase.from("sales_receipts").select(RECEIPT_SELECT).is("drive_file_id", null).order("issued_at").limit(50),
      supabase.from("sales_receipts").select(RECEIPT_SELECT).not("drive_file_id", "is", null).not("voided_at", "is", null).order("voided_at").limit(50),
    ]);
    if (e1) throw new DriveError(e1.message);
    if (e2) throw new DriveError(e2.message);
    let saved = 0;
    let lastError: string | undefined;
    for (const r of (missing ?? []) as SalesReceipt[]) {
      try { await putReceipt(supabase, conn, r); saved++; }
      catch (e) { lastError = e instanceof Error ? e.message : String(e); console.error(`[drive] kvitto ${r.number}: ${lastError}`); }
    }
    // a void after the upload: the file in Drive gets the stamp (only when it was voided after it was saved)
    for (const r of (voided ?? []) as SalesReceipt[]) {
      if (!r.drive_saved_at || !r.voided_at || Date.parse(r.voided_at) <= Date.parse(r.drive_saved_at)) continue;
      try {
        await putReceipt(supabase, conn, r);
        const { error } = await supabase.rpc("sales_receipt_in_drive", { p_id: r.id, p_drive_id: r.drive_file_id });   // drive_saved_at = now → done
        if (error) throw new DriveError(error.message);
        saved++;
      } catch (e) { lastError = e instanceof Error ? e.message : String(e); console.error(`[drive] kvitto void ${r.number}: ${lastError}`); }
    }
    return lastError && saved === 0 ? { state: "failed", saved, message: lastError } : { state: "saved", saved, message: lastError };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[drive] kvitton sync: ${message}`);
    return { state: "failed", saved: 0, message };
  }
}
