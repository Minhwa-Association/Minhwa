/**
 * The receipt as a PDF (v17) — one A4 page, drawn with pdf-lib from a sales_receipts row.
 * The same bytes go to the member (Download PDF) and to the association's Drive, so the two copies are
 * always the same document. Fonts: Noto Sans KR, cut down to Latin + Hangul (lib/fonts) — names in
 * Swedish, English or Korean all come out right.
 *
 * Server only — never import this from a client component.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFDocument, rgb, degrees, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { money, num, swishPretty, type SalesReceipt } from "@/lib/receipts";

const INK = rgb(0x2d / 255, 0x33 / 255, 0x52 / 255);
const MUTED = rgb(0x5b / 255, 0x5f / 255, 0x78 / 255);
const LINE = rgb(0xcf / 255, 0xc3 / 255, 0xb1 / 255);
const RED = rgb(0xe1 / 255, 0x25 / 255, 0x2d / 255);
const PAPER = rgb(0xf6 / 255, 0xf1 / 255, 0xe8 / 255);

const PAGE_W = 595.28, PAGE_H = 841.89;     // A4
const M = 56;                               // margin
const W = PAGE_W - 2 * M;

let fontCache: { regular: Uint8Array; bold: Uint8Array } | null = null;
async function fontBytes() {
  if (!fontCache) {
    const dir = path.join(process.cwd(), "lib", "fonts");
    const [regular, bold] = await Promise.all([readFile(path.join(dir, "MinhwaSansKR-Regular.ttf")), readFile(path.join(dir, "MinhwaSansKR-Bold.ttf"))]);
    fontCache = { regular: new Uint8Array(regular), bold: new Uint8Array(bold) };
  }
  return fontCache;
}

/** split a string into lines that fit `width` at `size` (on spaces; a word longer than the line is cut) */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of (text ?? "").split(/\r?\n/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(t, size) <= width) { line = t; continue; }
      if (line) out.push(line);
      line = w;
      while (font.widthOfTextAtSize(line, size) > width && line.length > 1) {
        let cut = line.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > width) cut--;
        out.push(line.slice(0, cut));
        line = line.slice(cut);
      }
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

type Pen = { page: PDFPage; regular: PDFFont; bold: PDFFont; y: number };

function text(p: Pen, s: string, x: number, size: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; right?: number } = {}) {
  const font = opts.bold ? p.bold : p.regular;
  const w = font.widthOfTextAtSize(s, size);
  const x0 = opts.right !== undefined ? opts.right - w : x;
  p.page.drawText(s, { x: x0, y: p.y, size, font, color: opts.color ?? INK });
  return w;
}

function paragraph(p: Pen, s: string, x: number, size: number, width: number, opts: { bold?: boolean; color?: ReturnType<typeof rgb>; lead?: number } = {}) {
  const font = opts.bold ? p.bold : p.regular;
  const lead = opts.lead ?? size * 1.38;
  for (const line of wrap(font, s, size, width)) {
    p.page.drawText(line, { x, y: p.y, size, font, color: opts.color ?? INK });
    p.y -= lead;
  }
}

function rule(p: Pen, x1: number, x2: number, color = LINE, thickness = 0.8) {
  p.page.drawLine({ start: { x: x1, y: p.y }, end: { x: x2, y: p.y }, thickness, color });
}

function dateText(iso: string): string {
  return iso.slice(0, 10);
}

/** the receipt as PDF bytes */
export async function receiptPdf(r: SalesReceipt): Promise<Uint8Array> {
  const fonts = await fontBytes();
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const regular = await doc.embedFont(fonts.regular, { subset: true });
  const bold = await doc.embedFont(fonts.bold, { subset: true });
  doc.setTitle(`${r.number} — ${r.org_name}`);
  doc.setAuthor(r.org_name);
  doc.setSubject(`Kvitto ${r.number} · ${r.title} · ${r.member_name}`);
  doc.setProducer("app.minhwa.org");
  doc.setCreator("app.minhwa.org");
  doc.setCreationDate(new Date(r.issued_at));
  doc.setModificationDate(new Date(r.issued_at));

  const page = doc.addPage([PAGE_W, PAGE_H]);
  const p: Pen = { page, regular, bold, y: PAGE_H - M };
  const right = PAGE_W - M;
  const voided = !!r.voided_at;

  // ── head: the association on the left, KVITTO + number + date on the right
  page.drawRectangle({ x: 0, y: PAGE_H - 10, width: PAGE_W, height: 10, color: INK });
  p.y = PAGE_H - M - 6;
  text(p, r.org_name, M, 19, { bold: true });
  text(p, "KVITTO", M, 22, { bold: true, right });
  p.y -= 16;
  text(p, "Receipt", M, 10.5, { color: MUTED, right });
  const headTop = p.y;

  // left column: org details
  p.y = headTop - 6;
  const details: string[] = [];
  if (r.org_number) details.push(`Org.nr ${r.org_number}`);
  for (const l of (r.org_address ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) details.push(l);
  if (r.org_email) details.push(r.org_email);
  if (r.swish_number) details.push(`Swish ${swishPretty(r.swish_number)}`);
  for (const d of details) { text(p, d, M, 9.5, { color: MUTED }); p.y -= 13; }
  const leftBottom = p.y;

  // right column: number · date · ref
  p.y = headTop - 20;
  const kv = (k: string, v: string, strong = false) => {
    text(p, k, M, 9, { color: MUTED, right: right - 112 });
    text(p, v, M, strong ? 11 : 10, { bold: strong, right });
    p.y -= strong ? 16 : 14;
  };
  kv("Kvittonr · Receipt no.", r.number, true);
  kv("Datum · Date", dateText(r.paid_on));
  if (r.payment_code) kv("Ref. · Payment code", r.payment_code);
  p.y = Math.min(p.y, leftBottom) - 10;
  rule(p, M, right);
  p.y -= 22;

  // ── who paid
  text(p, "Betalare · Paid by", M, 9, { color: MUTED });
  p.y -= 15;
  text(p, r.member_name, M, 13, { bold: true });
  p.y -= 30;

  // ── lines
  text(p, "Beskrivning · Description", M, 9, { color: MUTED });
  text(p, "Belopp · Amount", M, 9, { color: MUTED, right });
  p.y -= 8;
  rule(p, M, right);
  p.y -= 16;
  const lines = Array.isArray(r.lines) && r.lines.length ? r.lines : [{ text: `${r.title} · ${r.description}`, amount_sek: num(r.total_sek) }];
  for (const l of lines) {
    const amount = money(l.amount_sek);
    const amountW = p.regular.widthOfTextAtSize(amount, 10.5) + 24;
    text(p, amount, M, 10.5, { right });
    paragraph(p, l.text, M, 10.5, W - amountW);
    p.y -= 4;
  }
  p.y += 2;
  rule(p, M, right, INK, 1);
  p.y -= 20;
  text(p, "Summa · Total", M, 11, { bold: true });
  text(p, money(r.total_sek), M, 14, { bold: true, right });
  p.y -= 30;

  // ── how it was paid
  text(p, "Betalning · Payment", M, 9, { color: MUTED });
  p.y -= 15;
  const swish = num(r.swish_sek), credit = num(r.credit_sek);
  if (swish > 0) {
    text(p, `Swish · ${money(swish)}`, M, 10.5);
    text(p, dateText(r.paid_on), M, 10, { color: MUTED, right });
    p.y -= 15;
  }
  if (credit > 0) {
    text(p, `Credits · ${money(credit)}`, M, 10.5);
    text(p, dateText(r.paid_on), M, 10, { color: MUTED, right });
    p.y -= 14;
    paragraph(p, `1 credit = 1 kr. Credits are what the association owed this member${r.credit_source ? ` — ${r.credit_source}` : ""}.`, M, 9, W - 80, { color: MUTED });
  }
  if (swish === 0 && credit === 0) { text(p, `${money(0)}`, M, 10.5); p.y -= 15; }
  p.y -= 12;

  // ── note (VAT etc.)
  if (r.note) {
    paragraph(p, r.note, M, 9, W, { color: MUTED });
    p.y -= 8;
  }
  // ── void: why, right under the rest
  if (voided) {
    p.y -= 6;
    const why = `This receipt was made void ${r.voided_at!.slice(0, 10)}${r.void_reason ? ` — ${r.void_reason}` : ""}. It is kept for the books; the number is not reused.`;
    paragraph(p, why, M, 9.5, W, { color: RED });
  }

  // ── foot
  const foot = `Issued ${r.issued_at.slice(0, 10)} by app.minhwa.org · ${r.title} · ${r.description}`;
  p.y = M + 14;
  rule(p, M, right);
  p.y -= 14;
  paragraph(p, foot, M, 8, W, { color: MUTED });
  page.drawRectangle({ x: 0, y: 0, width: PAGE_W, height: 6, color: PAPER });

  // ── void: a stamp across the page
  if (voided) {
    page.drawText("ANNULLERAD · VOID", {
      x: 96, y: 330, size: 48, font: bold, color: RED, opacity: 0.28, rotate: degrees(28),
    });
  }

  return doc.save();
}
