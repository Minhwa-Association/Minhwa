import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { buildICS } from "@/lib/ics";
import type { EventRow } from "@/lib/calendar";

// Personal calendar feed: https://app.minhwa.org/cal/<token>.ics
// Fetched by the phone's calendar app without login — the token is the key.
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const t = token.replace(/\.ics$/i, "");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t)) {
    return new NextResponse("Not found", { status: 404 });
  }
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.rpc("events_for_token", { p_token: t });
  if (error) return new NextResponse("This calendar link is not valid.", { status: 404 });

  const host = req.headers.get("host") ?? "app.minhwa.org";
  const body = buildICS((data ?? []) as EventRow[], "Minhwa Association", host);
  return new NextResponse(body, {
    status: 200,
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="minhwa.ics"',
      "Cache-Control": "private, max-age=300",
    },
  });
}
