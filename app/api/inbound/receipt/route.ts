import { handleResendEvent } from "@/lib/comms/resend-webhook";

/**
 * POST /api/inbound/receipt — Resend calls this for every mail that reaches *@in.minhwa.org.
 * Since v19 the same handler also serves the Inbox: a mail for receipt@ becomes a claim (as before),
 * a mail for manager@ becomes an Inbox thread. /api/inbound/mail is the same thing under a newer name.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  return handleResendEvent(req);
}

export async function GET() {
  return Response.json({ ok: true, hint: "Resend posts email.received events here." });
}
