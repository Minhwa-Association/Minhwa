import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient, currentMember } from "@/lib/supabase/server";
import { hasRole } from "@/lib/roles";
import { callbackUrl, DriveError, ensureFolders, exchangeCode, requestOrigin, sealToken } from "@/lib/drive";

/** Google sends the admin back here after "Allow" — keep the key, make the folders, back to Settings. */
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) return NextResponse.redirect(new URL("/", origin));
  const settings = new URL("/admin/settings", origin);
  const back = (key: "ok" | "error", value: string) => {
    settings.searchParams.set(key, value);
    const res = NextResponse.redirect(settings);
    res.cookies.set("g_state", "", { path: "/api/google", maxAge: 0 });
    return res;
  };

  const q = req.nextUrl.searchParams;
  if (q.get("error")) return back("error", q.get("error") === "access_denied" ? "Google Drive was not connected — access was not allowed." : `Google said: ${q.get("error")}`);
  const code = q.get("code");
  const state = q.get("state");
  if (!code || !state || state !== req.cookies.get("g_state")?.value) return back("error", "The Google sign-in timed out or came from somewhere else — tap Connect Google Drive again.");

  try {
    const { accessToken, refreshToken, email } = await exchangeCode(code, callbackUrl(origin));
    if (!refreshToken) throw new DriveError("Google gave no lasting key. In the Google account go to Security → Third-party access, remove “Minhwa app”, then connect again.");
    const supabase = await createClient();
    // same account as before → keep (or remake) the same folders
    const { data: prev } = await supabase.rpc("drive_status");
    const old = (Array.isArray(prev) ? prev[0] : prev) as { email: string; root_folder_id: string | null; receipts_folder_id: string | null; kvitton_folder_id: string | null } | undefined;
    const same = !!old && !!email && old.email === email.toLowerCase();
    const folders = await ensureFolders(accessToken, same ? old!.root_folder_id : null, same ? old!.receipts_folder_id : null, same ? old!.kvitton_folder_id : null);
    const { error } = await supabase.rpc("drive_connect", { p_email: email ?? "unknown", p_token_enc: sealToken(refreshToken), p_root: folders.root, p_receipts: folders.receipts });
    if (error) throw new DriveError(error.message);
    // v17: the Kvitton folder goes next to the other two
    const { error: e2 } = await supabase.rpc("drive_set_folders", { p_root: folders.root, p_receipts: folders.receipts, p_kvitton: folders.kvitton });
    if (e2) throw new DriveError(e2.message);
    revalidatePath("/admin/settings");
    revalidatePath("/payments/receipts");
    revalidatePath("/payments/kvitton");
    return back("ok", "drive_connected");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[drive] connect: ${msg}`);
    return back("error", msg);
  }
}
