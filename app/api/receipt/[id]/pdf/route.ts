import { NextResponse, type NextRequest } from "next/server";
import { createClient, currentMember } from "@/lib/supabase/server";
import { receiptPdf } from "@/lib/receipt-pdf";
import { RECEIPT_SELECT, type SalesReceipt } from "@/lib/receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * /api/receipt/[id]/pdf — the receipt as a PDF, drawn on the spot from the stored receipt (the same bytes
 * the Drive copy got). Members get their own; the treasurer / admin any. ?download=1 saves instead of opening.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const me = await currentMember();
  if (!me) return new NextResponse("Log in first", { status: 401 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return new NextResponse("Not found", { status: 404 });
  const supabase = await createClient();
  const { data, error } = await supabase.from("sales_receipts").select(RECEIPT_SELECT).eq("id", id).maybeSingle();   // RLS: own, or treasurer / admin
  if (error) return new NextResponse(error.message, { status: 500 });
  if (!data) return new NextResponse("Not found", { status: 404 });
  const r = data as SalesReceipt;
  try {
    const pdf = await receiptPdf(r);
    const download = req.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${r.number}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[receipt pdf] ${r.number}: ${msg}`);
    return new NextResponse(`Could not make the PDF: ${msg}`, { status: 500 });
  }
}
