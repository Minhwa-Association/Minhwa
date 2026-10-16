import { handleResendEvent } from "@/lib/comms/resend-webhook";

/** POST /api/inbound/mail — Resend email.received → Kvitton (receipt@) or Inbox (manager@). Same as /api/inbound/receipt. */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  return handleResendEvent(req);
}

export async function GET() {
  return Response.json({ ok: true, hint: "Resend posts email.received events here (receipt@ → Kvitton, manager@ → Inbox)." });
}
