import { verifySignature, type IgWebhook } from "@/lib/comms/instagram";
import { handleInstagramWebhook } from "@/lib/comms/ingest";

/**
 * Meta → /api/inbound/instagram
 *   GET  — the one-time handshake when the webhook is registered (hub.verify_token must equal IG_VERIFY_TOKEN).
 *   POST — every DM to the association's account (field "messages"); signed with the app secret.
 * Meta expects a 200 within a few seconds and retries otherwise, so the message is stored and the answer
 * sent at once; Claude's sorting runs after the answer. A message seen twice (retry) is ignored by its mid.
 */
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  const expected = process.env.IG_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token === expected && challenge) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  if (!mode) return Response.json({ ok: true, hint: "Meta posts Instagram message events here." });
  return new Response("verify token does not match", { status: 403 });
}

export async function POST(req: Request) {
  const secret = process.env.IG_APP_SECRET;
  if (!secret) return Response.json({ error: "IG_APP_SECRET is not set" }, { status: 500 });
  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("x-hub-signature-256"), secret)) {
    return Response.json({ error: "signature does not match" }, { status: 401 });
  }
  let body: IgWebhook;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "not JSON" }, { status: 400 }); }
  try {
    const result = await handleInstagramWebhook(body);
    return Response.json({ ok: true, ...result });
  } catch (e) {
    console.error("inbound instagram", e instanceof Error ? e.message : e);
    // still 200: Meta would otherwise retry for hours; the message is in the raw log of the error
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "failed" });
  }
}
