import { verifyWebhook } from "@/lib/mail/resend";
import { handleReceivedMail } from "@/lib/comms/ingest";

/**
 * The one handler behind /api/inbound/mail and /api/inbound/receipt. Resend posts email.received for
 * everything that reaches *@in.minhwa.org: the receipt copy (receipt@ → Kvitton, as before) and, from
 * v19, the manager@ copy (→ Inbox). No login: the Svix signature is the key. Storing happens before the
 * answer; Claude's reading / sorting runs after it (after()).
 */
export async function handleResendEvent(req: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return Response.json({ error: "RESEND_WEBHOOK_SECRET is not set" }, { status: 500 });
  const raw = await req.text();
  const check = verifyWebhook(raw, req.headers, secret);
  if (!check.ok) return Response.json({ error: check.reason }, { status: 401 });

  let event: { type?: string; data?: { email_id?: string } };
  try { event = JSON.parse(raw); } catch { return Response.json({ error: "not JSON" }, { status: 400 }); }
  if (event.type !== "email.received") return Response.json({ ok: true, ignored: event.type ?? "unknown" });
  const emailId = event.data?.email_id;
  if (!emailId) return Response.json({ error: "email_id missing" }, { status: 400 });

  try {
    const result = await handleReceivedMail(emailId);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error("inbound mail", emailId, e instanceof Error ? e.message : e);
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
