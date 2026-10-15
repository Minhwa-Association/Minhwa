import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { currentMember } from "@/lib/supabase/server";
import { hasRole } from "@/lib/roles";
import { authUrl, callbackUrl, driveConfigured, requestOrigin } from "@/lib/drive";

/** Settings → "Connect Google Drive": off to Google's sign-in (admin only). */
export async function GET(req: NextRequest) {
  const origin = requestOrigin(req);
  const me = await currentMember();
  if (!me || !hasRole(me, "admin")) return NextResponse.redirect(new URL("/", origin));
  const settings = new URL("/admin/settings", origin);
  if (!driveConfigured()) {
    settings.searchParams.set("error", "Google is not set up yet — add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Vercel, then redeploy.");
    return NextResponse.redirect(settings);
  }
  const state = crypto.randomBytes(16).toString("hex");
  const res = NextResponse.redirect(authUrl(callbackUrl(origin), state));
  res.cookies.set("g_state", state, { httpOnly: true, sameSite: "lax", secure: origin.startsWith("https:"), path: "/api/google", maxAge: 600 });
  return res;
}
