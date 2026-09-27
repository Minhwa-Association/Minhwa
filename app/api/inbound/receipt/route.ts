import { after } from "next/server";
import { verifyWebhook } from "@/lib/mail/resend";
import { finishClaim, ingestInboundEmail } from "@/lib/claims-process";

/**
 * POST /api/inbound/receipt — Resend calls this for every mail that reaches receipt@in.minhwa.org
 * (the copy Microsoft 365 forwards from receipt@minhwa.org). No login: the Svix signature is the key.
 * The mail is stored and the claim created before answering; reading the receipt and the "received"
 * reply run right after the answer (after()), so the webhook never waits for Claude.
 */
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
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
    const result = await ingestInboundEmail(emailId);
    if (result.created) {
      after(async () => {
        try { await finishClaim(result.claimId, { sendAck: true }); }
        catch (e) { console.error("finishClaim", result.code, e instanceof Error ? e.message : e); }
      });
    }
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error("inbound receipt", emailId, e instanceof Error ? e.message : e);
    return Response.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, hint: "Resend posts email.received events here." });
}
