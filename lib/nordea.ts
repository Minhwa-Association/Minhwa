/**
 * Nordea statement parser — two export shapes are known:
 *
 * Personal account (Personkonto), ";"-separated, comma decimals:
 *   Bokföringsdag;Belopp;Avsändare;Mottagare;Namn;Rubrik;Saldo;Valuta;
 *   2026/09/15;96,00;;4395 02 05655;;Swish inbetalning Jisu Park;2390,10;SEK;
 *
 * Association account (PlusGiro företag), as Nordea exports it or after a pass through a spreadsheet
 * (then ","-separated with quoted names and point decimals):
 *   Bokföringsdag,Belopp,Avsändare,Mottagare,Namn,Ytterligare detaljer,Meddelande,Egna anteckningar,Saldo,Valuta
 *   2024/10/08,300,SWISH INBETAL,,Inbetalning Swish Företag,,"LEE, KAEUN",Membership,5718,SEK
 *
 * Neither shape carries the Swish message or a reference number. An incoming Swish shows the
 * payer's name — in "Rubrik" (personal) or in "Meddelande" (association, in the bank's own
 * "SURNAME,GIVEN" spelling, cut at 20 characters). "Saldo" is written on one line per day only.
 * So matching to a member goes by amount + name + date, and a line is identified by
 * date + amount + text + name + message + its position among identical lines.
 *
 * Rows copied from the web bank (tab-separated, with or without a header) are read too.
 */

export type BankRow = {
  booked_on: string;           // YYYY-MM-DD
  amount_sek: number;          // + in, − out
  title: string;               // "Swish inbetalning Jisu Park" · "Inbetalning Swish Företag" · "Nordea · Woo Bock Lee"
  counterparty: string | null; // "Jisu Park" · "LEE, KAEUN" · "Woo Bock Lee"
  message: string | null;      // the bank's Meddelande column as it is (for Swish that is the payer's name again)
  own_notes: string | null;    // Egna anteckningar — notes written in the internet bank
  balance_sek: number | null;
  seq: number;                 // 1, 2, … among lines in this paste that are otherwise identical
  raw: string;
};

export type ParseResult = { rows: BankRow[]; skipped: string[] };

const YMD = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const DMY = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/;
const NUMERIC = /^[-+−]?\d[\d  .,']*$/;
const CURRENCY = /^[A-Z]{3}$/;
const ACCOUNT = /^[\d -]{8,}$/;   // "4395 02 05655" · "54 56 85-0"

export function parseDate(s: string): string | null {
  const t = s.trim();
  let m = YMD.exec(t);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = DMY.exec(t);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  return null;
}

/** "-100,00" → -100 · "3 000,00" → 3000 · "1.234,56" → 1234.56 · "252.8" → 252.8 · "1.234" → 1234 */
export function parseAmount(s: string): number | null {
  let t = s.trim().replace(/[  ']/g, "").replace(/^−/, "-").replace(/^\+/, "");
  if (!t || !/\d/.test(t)) return null;
  const lastComma = t.lastIndexOf(",");
  const lastDot = t.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    t = lastComma > lastDot ? t.replace(/\./g, "").replace(",", ".") : t.replace(/,/g, "");
  } else if (lastComma >= 0) {
    t = t.replace(",", ".");
  } else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(t)) {
    t = t.replace(/\./g, "");   // "1.234" / "1.234.567" = thousands, not decimals
  }
  if (!/^-?\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** "Swish inbetalning Jisu Park" → "Jisu Park" · "Kortköp 260918 TWILIO.COM" → "TWILIO.COM" · "Insättning" → null */
export function counterpartyOf(title: string): string | null {
  const t = title.trim();
  let m = /^swish\s+(?:inbetalning|betalning|återbetalning|utbetalning|mottagen|skickad)\s+(.+)$/i.exec(t);
  if (m) return m[1].trim();
  m = /^kortköp\s+\d{6}\s+(.+)$/i.exec(t);
  if (m) return m[1].trim();
  m = /^(?:betalning|överföring|insättning|autogiro|bg|pg)\s+(?:till|från|to|from)?\s*(.+)$/i.exec(t);
  if (m && m[1] && !/^\d/.test(m[1])) return m[1].trim();
  return null;
}

// ---- CSV -------------------------------------------------------------------

/** Split one line on `sep`, honouring "quoted, fields" and doubled quotes. */
function splitCsvLine(line: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === sep) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

/** Which separator a line uses: the one that appears most often outside quotes (tab · ; · ,). */
function detectSep(line: string): string | null {
  const counts: Record<string, number> = { "\t": 0, ";": 0, ",": 0 };
  let inQ = false;
  for (const ch of line) {
    if (ch === '"') inQ = !inQ;
    else if (!inQ && ch in counts) counts[ch]++;
  }
  const best = (Object.keys(counts) as (keyof typeof counts)[]).sort((a, b) => counts[b] - counts[a])[0];
  return counts[best] >= 2 ? best : null;
}

// ---- header mapping ----------------------------------------------------------

type ColMap = {
  date: number; amount: number;
  rubrik?: number; namn?: number; details?: number; message?: number; ownNotes?: number;
  sender?: number; receiver?: number; balance?: number;
};

function headerMap(cells: string[]): ColMap | null {
  const low = cells.map((c) => c.toLowerCase().replace(/\s+/g, " ").trim());
  const find = (...keys: string[]) => low.findIndex((c) => keys.some((k) => c === k || c.startsWith(k)));
  const date = find("bokföringsdag", "bokforingsdag", "transaktionsdag", "valutadag", "datum", "date");
  const amount = find("belopp", "amount", "summa");
  if (date < 0 || amount < 0) return null;
  const opt = (i: number) => (i >= 0 ? i : undefined);
  return {
    date, amount,
    rubrik: opt(find("rubrik", "text", "beskrivning", "description", "specifikation", "transaktion")),
    namn: opt(find("namn", "name")),
    details: opt(find("ytterligare detaljer", "detaljer", "details")),
    message: opt(find("meddelande", "message", "referens", "ocr")),
    ownNotes: opt(find("egna anteckningar", "anteckning", "notes")),
    sender: opt(find("avsändare", "avsandare", "sender", "från")),
    receiver: opt(find("mottagare", "receiver", "till")),
    balance: opt(find("saldo", "balance")),
  };
}

function isSwish(...parts: (string | undefined | null)[]): boolean {
  return parts.some((p) => p && /swish/i.test(p));
}

/** Build one row from mapped columns. */
function fromMapped(cells: string[], m: ColMap, raw: string): BankRow | null {
  const at = (i?: number) => (i === undefined ? "" : (cells[i] ?? "").trim());
  const booked_on = parseDate(at(m.date));
  const amount = parseAmount(at(m.amount));
  if (!booked_on || amount === null) return null;

  const rubrik = at(m.rubrik), namn = at(m.namn), details = at(m.details), message = at(m.message);
  const ownNotes = at(m.ownNotes), sender = at(m.sender), receiver = at(m.receiver);
  const balance = m.balance === undefined ? null : parseAmount(at(m.balance));

  let title: string;
  let counterparty: string | null;
  if (rubrik) {
    // personal-account shape: everything is in Rubrik
    title = rubrik;
    counterparty = counterpartyOf(rubrik) ?? (namn || null);
  } else {
    // association shape: Namn = kind of line or bank, Ytterligare detaljer = the other party, Meddelande = message (or payer's name for Swish)
    const swish = isSwish(sender, receiver, namn, details);
    if (swish && amount > 0) {
      title = namn || "Swish";
      counterparty = message || details || null;
    } else {
      const other = details && details !== namn ? details : "";
      title = [namn, other].filter(Boolean).join(" · ") || message || sender || receiver || "Transaction";
      counterparty = other || (namn && !/^nordea$/i.test(namn) ? namn : null) || null;
    }
  }
  if (!title) return null;

  return {
    booked_on, amount_sek: amount, title,
    counterparty: counterparty || null,
    message: message || null,
    own_notes: ownNotes || null,
    balance_sek: balance,
    seq: 1,
    raw,
  };
}

/** No usable header: find the pieces by their shape (a date, numbers, the longest text). */
function fromShape(cells: string[], raw: string): BankRow | null {
  const dateIdx = cells.findIndex((c) => parseDate(c));
  if (dateIdx < 0) return null;
  const booked_on = parseDate(cells[dateIdx])!;
  const numericIdx = cells.map((c, i) => (i !== dateIdx && NUMERIC.test(c) && !ACCOUNT.test(c) && parseAmount(c) !== null ? i : -1)).filter((i) => i >= 0);
  const textIdx = cells.map((c, i) => (i !== dateIdx && /[A-Za-zÀ-ÖØ-öø-ÿ가-힣]/.test(c) && !CURRENCY.test(c) ? i : -1)).filter((i) => i >= 0);
  if (numericIdx.length === 0 || textIdx.length === 0) return null;
  const amount = parseAmount(cells[numericIdx[0]]);
  if (amount === null) return null;
  const balance = numericIdx.length >= 2 ? parseAmount(cells[numericIdx[numericIdx.length - 1]]) : null;
  const title = cells[textIdx.reduce((a, b) => (cells[b].length > cells[a].length ? b : a))];
  return { booked_on, amount_sek: amount, title, counterparty: counterpartyOf(title), message: null, own_notes: null, balance_sek: balance, seq: 1, raw };
}

export function parseNordea(text: string): ParseResult {
  const rows: BankRow[] = [];
  const skipped: string[] = [];
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[,;\s]*$/.test(l));
  let map: ColMap | null = null;
  let sep: string | null = null;

  for (const line of lines) {
    const lineSep: string | null = detectSep(line) ?? sep;
    if (!lineSep) { skipped.push(line); continue; }
    const cells = splitCsvLine(line, lineSep);
    if (cells.length < 3) { skipped.push(line); continue; }

    if (!map && !cells.some((c) => parseDate(c))) {
      const hm = headerMap(cells);
      if (hm) { map = hm; sep = lineSep; continue; }
      skipped.push(line);   // title lines above the header ("Minhwa 2024 bankstatement", account name…)
      continue;
    }

    const row = (map ? fromMapped(cells, map, line) : null) ?? fromShape(cells, line);
    if (row) rows.push(row); else skipped.push(line);
  }

  // identical lines on the same day (same amount, text, name, message — the balance is not on every line)
  // are numbered 1, 2, … so each one is stored once and no real line is lost
  const seen = new Map<string, number>();
  for (const r of rows) {
    const key = [r.booked_on, r.amount_sek.toFixed(2), r.title.toLowerCase(), (r.counterparty ?? "").toLowerCase(), (r.message ?? "").toLowerCase()].join("|");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    r.seq = n;
  }
  return { rows, skipped };
}

/** File → text: Nordea saves UTF-8 (with BOM); older exports may be Windows-1252. */
export function decodeStatement(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (!utf8.includes("�")) return utf8;
  try { return new TextDecoder("windows-1252").decode(bytes); } catch { return utf8; }
}
