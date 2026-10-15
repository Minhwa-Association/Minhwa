import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient, currentMember } from "@/lib/supabase/server";
import { canUsePayments } from "@/lib/roles";
import { parseISODate, shortDate } from "@/lib/dates";
import { Notice, TopNav } from "@/app/components";
import { SubmitButton } from "@/app/SubmitButton";
import { kr } from "@/lib/payments";
import { addIncomeEntry, deleteIncomeEntry, saveTaxSettings, setBankCategory, setTaxClass } from "./actions";

type Q = { error?: string; ok?: string; year?: string };
type Row = { category_code: string; name: string; bas: string; tax_class: TaxClass; source: "payments" | "bank" | "entries"; amount_sek: number | string; n: number };
type Cat = { code: string; name: string; bas: string; tax_class: TaxClass; tax_note: string | null; sort: number };
type Tx = { id: string; booked_on: string; amount_sek: number | string; title: string; counterparty: string | null; message: string | null; own_notes: string | null; status: string; category_code: string | null };
type Entry = { id: string; booked_on: string; amount_sek: number | string; category_code: string; note: string | null; category: { name: string } | null };
type TaxClass = "exempt" | "natural" | "other" | "unsure";

const CLASSES: { key: TaxClass; label: string; hint: string }[] = [
  { key: "natural", label: "Natural connection", hint: "counts towards the 75 %" },
  { key: "other", label: "No connection", hint: "the 25 % side" },
  { key: "unsure", label: "Not decided", hint: "counted on the 25 % side until the accountant answers" },
  { key: "exempt", label: "Outside the rule", hint: "membership fees, grants, gifts, interest — always tax-free" },
];
const SOURCE_WORD = { payments: "member payments", bank: "bank lines", entries: "typed in" } as const;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const LIMIT_PCT = 25;

function okText(q: Q): string | undefined {
  switch (q.ok) {
    case "class": return "Saved.";
    case "sorted": return "The bank line now counts in that category.";
    case "unsorted": return "The bank line is back among the unsorted.";
    case "entry": return "Added.";
    case "entry_removed": return "Removed.";
    case "settings": return "Settings saved.";
    default: return undefined;
  }
}

function num(v: number | string | null | undefined): number { return Number(v ?? 0) || 0; }
function pct(part: number, whole: number): number { return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0; }
function fmtPct(p: number): string { return `${p.toLocaleString("en-GB", { maximumFractionDigits: 1 })} %`; }

/** Payments → Tax check — is at least 75 % of this year's business income "naturally connected" to the association's purpose? (v18) */
export default async function TaxCheckPage({ searchParams }: { searchParams: Promise<Q> }) {
  const me = await currentMember();
  if (!me) redirect("/login");
  if (!canUsePayments(me)) redirect("/");
  const q = await searchParams;
  const supabase = await createClient();

  const [{ data: settings }, { data: yearRows }] = await Promise.all([
    supabase.from("settings").select("tax_warn_pct, tax_year_start_month").eq("id", 1).single(),
    supabase.rpc("tax_watch_years"),
  ]);
  const warnPct = Number(settings?.tax_warn_pct ?? 20);
  const startMonth = Number(settings?.tax_year_start_month ?? 1);
  const years: number[] = ((yearRows ?? []) as (number | { tax_watch_years: number })[]).map((r) => (typeof r === "number" ? r : Number(r.tax_watch_years))).filter((y) => Number.isFinite(y));
  const requested = Number(q.year);
  const year = years.includes(requested) ? requested : (years[0] ?? new Date().getFullYear());
  const yearLabel = startMonth === 1 ? String(year) : `${year}/${String(year + 1).slice(2)}`;

  const [{ data: rows }, { data: cats }, { data: unsorted }, { data: sortedTx }, { data: entries }] = await Promise.all([
    supabase.rpc("tax_watch", { p_year: year }),
    supabase.from("ledger_categories").select("code, name, bas, tax_class, tax_note, sort").eq("kind", "income").eq("active", true).order("sort"),
    supabase.from("bank_transactions").select("id, booked_on, amount_sek, title, counterparty, message, own_notes, status, category_code")
      .is("payment_id", null).is("category_code", null).gt("amount_sek", 0).in("status", ["unmatched", "ignored"]).order("booked_on", { ascending: false }).limit(100),
    supabase.from("bank_transactions").select("id, booked_on, amount_sek, title, counterparty, message, own_notes, status, category_code")
      .is("payment_id", null).not("category_code", "is", null).gt("amount_sek", 0).order("booked_on", { ascending: false }).limit(200),
    supabase.from("tax_income_entries").select("id, booked_on, amount_sek, category_code, note, category:ledger_categories(name)").order("booked_on", { ascending: false }).limit(200),
  ]);
  const list = (rows ?? []) as Row[];
  const categories = (cats ?? []) as Cat[];
  const unsortedTx = (unsorted ?? []) as Tx[];
  const sortedLines = ((sortedTx ?? []) as Tx[]).filter((t) => inYear(t.booked_on, year, startMonth));
  const entryList = ((entries ?? []) as unknown as Entry[]).filter((e) => inYear(e.booked_on, year, startMonth));

  // totals by class
  const byClass: Record<TaxClass, number> = { exempt: 0, natural: 0, other: 0, unsure: 0 };
  for (const r of list) byClass[r.tax_class] += num(r.amount_sek);
  const business = byClass.natural + byClass.other + byClass.unsure;
  const otherSide = byClass.other + byClass.unsure;
  const naturalPct = pct(byClass.natural, business);
  const otherPct = pct(otherSide, business);
  const otherOnlyPct = pct(byClass.other, business);
  // how much more "other" income fits before the 25 % line (other ≤ natural / 3)
  const headroom = Math.max(0, Math.floor(byClass.natural / 3 - otherSide));
  const state: "empty" | "ok" | "warn" | "bad" = business === 0 ? "empty" : otherPct >= LIMIT_PCT ? "bad" : otherPct >= warnPct ? "warn" : "ok";

  // category rows: one line per category, sources summed
  const byCat = new Map<string, { cat: Cat; total: number; parts: string[] }>();
  for (const c of categories) byCat.set(c.code, { cat: c, total: 0, parts: [] });
  for (const r of list) {
    const e = byCat.get(r.category_code) ?? { cat: { code: r.category_code, name: r.name, bas: r.bas, tax_class: r.tax_class, tax_note: null, sort: 999 }, total: 0, parts: [] };
    e.total += num(r.amount_sek);
    e.parts.push(`${r.n} ${SOURCE_WORD[r.source]}`);
    byCat.set(r.category_code, e);
  }
  const catRows = [...byCat.values()].sort((a, b) => a.cat.sort - b.cat.sort);

  const meterColor = state === "bad" ? "var(--red)" : state === "warn" ? "var(--gold-line)" : "var(--green-line)";
  const stateText =
    state === "empty" ? "No business income yet this year." :
    state === "ok" ? `Fine — ${fmtPct(naturalPct)} of business income has a natural connection (at least 75 % needed).` :
    state === "warn" ? `Watch it — the other side is at ${fmtPct(otherPct)} (warning from ${warnPct} %, limit ${LIMIT_PCT} %).` :
    `Over the line — the other side is ${fmtPct(otherPct)} of business income. If the year ends like this, all business income is taxed.`;

  return (
    <main className="page wide">
      <div className="topbar">
        <div><h1>Tax check</h1><div className="muted small">The 75 % rule for business income, during the year · <Link href="/payments">← Payments</Link></div></div>
        <TopNav current="payments" me={me} />
      </div>

      <div className="stack" style={{ gap: 18 }}>
        <Notice error={q.error} ok={q.ok} text={okText(q)} />

        {/* the rule, in three lines */}
        <div className="card stack" style={{ padding: 18, gap: 6 }}>
          <div className="small">
            <b>Why this page.</b> A public-benefit association keeps its business income tax-free only while <b>at least 75 %</b> of that
            income has a <b>natural connection</b> to its purpose — seat fees, passes, course fees, material sold to members, bazaars.
            Income with <b>no such connection</b> (work for companies, a shop run like a business) may be at most 25 % — one krona over and
            <b> all</b> business income is taxed (20.6 %). Membership fees, grants, gifts and interest sit outside the rule.
          </div>
          <div className="muted small">
            Member payments count when confirmed (Swish + credits). Bank lines that are not member payments, and anything typed in below, count by
            the category you give them. The <b>other 75 % rule</b> (use at least 75 % of income for the purpose, over a few years) needs the
            expenses too — that comes with the ledger.
          </div>
        </div>

        {/* year + meter */}
        <div className="card stack" style={{ padding: 18, gap: 12 }}>
          <div className="row between" style={{ flexWrap: "wrap", gap: 8 }}>
            <h2 style={{ margin: 0 }}>Financial year {yearLabel}</h2>
            {years.length > 1 && (
              <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                {years.map((y) => <Link key={y} href={`/payments/tax?year=${y}`} className={`pill ${y === year ? "active" : ""}`}>{startMonth === 1 ? y : `${y}/${String(y + 1).slice(2)}`}</Link>)}
              </div>
            )}
          </div>

          <div style={{ fontWeight: 700, color: state === "bad" ? "#8a1f24" : state === "warn" ? "var(--gold-text)" : state === "ok" ? "var(--green-text)" : "var(--muted)" }}>{stateText}</div>

          {business > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              <div style={{ position: "relative", height: 22, borderRadius: 999, background: "var(--divider)", overflow: "hidden" }} title={`Natural ${fmtPct(naturalPct)} · other ${fmtPct(otherPct)}`}>
                <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, naturalPct)}%`, background: meterColor, borderRadius: 999 }} />
                <div style={{ position: "absolute", left: "75%", top: 0, bottom: 0, width: 2, background: "var(--ink)" }} title="75 % line" />
              </div>
              <div className="row between small muted" style={{ flexWrap: "wrap", gap: 6 }}>
                <span>Natural connection <b>{kr(byClass.natural)}</b> · {fmtPct(naturalPct)}</span>
                <span>Other side <b>{kr(otherSide)}</b> · {fmtPct(otherPct)}{byClass.unsure > 0 && <> (of which not decided {kr(byClass.unsure)}; without it {fmtPct(otherOnlyPct)})</>}</span>
              </div>
              <div className="row between small muted" style={{ flexWrap: "wrap", gap: 6 }}>
                <span>Business income in all <b>{kr(business)}</b></span>
                <span>Outside the rule (tax-free anyway) <b>{kr(byClass.exempt)}</b></span>
              </div>
              <div className="small">
                {headroom > 0
                  ? <>Room left on the other side this year: about <b>{kr(headroom)}</b> — beyond that the line is crossed unless more natural-connection income comes in.</>
                  : <>No room left on the other side — every krona of natural-connection income now makes room for 33 öre on the other side.</>}
              </div>
            </div>
          )}
        </div>

        {/* by category */}
        <div className="card stack" style={{ padding: 18, gap: 10 }}>
          <h2>Income by category</h2>
          <div className="muted small">The class decides which side a category counts on. Seed values are a first guess — change them when the accountant answers, and the page recalculates.</div>
          <div className="stack" style={{ gap: 8 }}>
            {catRows.map(({ cat, total, parts }) => (
              <form key={cat.code} action={setTaxClass} className="row" style={{ gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 8 }}>
                <input type="hidden" name="code" value={cat.code} />
                <input type="hidden" name="year" value={year} />
                <div style={{ flex: "1 1 220px" }}>
                  <b>{cat.name}</b><span className="muted small"> · BAS {cat.bas}</span>
                  <div className="muted small">{total > 0 ? <>{kr(total)} · {parts.join(" · ")}</> : "nothing this year"}{cat.tax_note ? <> · {cat.tax_note}</> : null}</div>
                </div>
                <select name="tax_class" defaultValue={cat.tax_class} className="inline" aria-label={`Class for ${cat.name}`}>
                  {CLASSES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
                </select>
                <SubmitButton className="btn line sm" pendingText="Saving…">Save</SubmitButton>
              </form>
            ))}
          </div>
          <div className="muted small">
            {CLASSES.map((c) => <span key={c.key} style={{ marginRight: 12 }}><b>{c.label}</b> — {c.hint}.</span>)}
          </div>
        </div>

        {/* bank lines that are not member payments */}
        <div className="card stack" style={{ padding: 18, gap: 10 }}>
          <h2>Incoming bank lines that are not member payments <span className={`count ${unsortedTx.length === 0 ? "zero" : ""}`}>{unsortedTx.length}</span></h2>
          <div className="muted small">Grants, gifts, a refund from a supplier … Give each a category so it counts on the right side. A line that is really a member&apos;s Swish payment is matched on the Payments page instead — leave it here.</div>
          {unsortedTx.length === 0 ? <div className="muted small">Nothing to sort.</div> : (
            <div className="stack" style={{ gap: 8 }}>
              {unsortedTx.map((t) => <BankLine key={t.id} t={t} year={year} categories={categories} />)}
            </div>
          )}
          {sortedLines.length > 0 && (
            <>
              <h3 style={{ marginTop: 8 }}>Sorted this year</h3>
              <div className="stack" style={{ gap: 8 }}>
                {sortedLines.map((t) => <BankLine key={t.id} t={t} year={year} categories={categories} />)}
              </div>
            </>
          )}
        </div>

        {/* typed-in income */}
        <div className="card stack" style={{ padding: 18, gap: 10 }}>
          <h2>Income not in the app or the bank statement</h2>
          <div className="muted small">Cash taken at a fair, a gift in kind sold on … Type it in so the ratio is right. (Member payments and bank lines are counted already — do not type those again.)</div>
          <form action={addIncomeEntry} className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <input type="hidden" name="year" value={year} />
            <label className="stack small" style={{ gap: 4, flex: "0 1 160px" }}>Date<input type="date" name="booked_on" required /></label>
            <label className="stack small" style={{ gap: 4, flex: "0 1 140px" }}>Amount (kr)<input type="number" name="amount_sek" min="1" step="1" inputMode="numeric" required /></label>
            <label className="stack small" style={{ gap: 4, flex: "1 1 220px" }}>Category
              <select name="category_code" required defaultValue="">
                <option value="" disabled>Choose…</option>
                {categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label className="stack small" style={{ gap: 4, flex: "2 1 220px" }}>Note<input name="note" maxLength={200} placeholder="e.g. cash at the art fair" /></label>
            <SubmitButton className="btn ink sm" pendingText="Adding…">Add</SubmitButton>
          </form>
          {entryList.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {entryList.map((e) => (
                <form key={e.id} action={deleteIncomeEntry} className="row small" style={{ gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 6 }}>
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="year" value={year} />
                  <span className="muted">{shortDate(parseISODate(e.booked_on))}</span>
                  <b>{kr(e.amount_sek)}</b>
                  <span>{e.category?.name ?? e.category_code}</span>
                  {e.note && <span className="muted">· {e.note}</span>}
                  <SubmitButton className="btn quiet sm" pendingText="…" style={{ marginLeft: "auto" }}>Remove</SubmitButton>
                </form>
              ))}
            </div>
          )}
        </div>

        {/* settings */}
        <form action={saveTaxSettings} className="card stack" style={{ padding: 18, gap: 10 }}>
          <h2>Settings</h2>
          <input type="hidden" name="year" value={year} />
          <div className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label className="stack small" style={{ gap: 4, flex: "0 1 200px" }}>Turn yellow when the other side reaches (%)
              <input type="number" name="tax_warn_pct" min="1" max="25" defaultValue={warnPct} required />
            </label>
            <label className="stack small" style={{ gap: 4, flex: "0 1 220px" }}>Financial year starts in
              <select name="tax_year_start_month" defaultValue={startMonth}>
                {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </select>
            </label>
            <SubmitButton className="btn line sm" pendingText="Saving…">Save</SubmitButton>
          </div>
          <div className="muted small">Red is always at 25 %. Most associations run a calendar year — change the month only if the statutes say otherwise.</div>
        </form>

        <div className="muted small">
          Sources: Skatteverket — <a href="https://skatteverket.se/foreningar/driva/ideellforening/villkorforattvaraenallmannyttigideellforening.4.70ac421612e2a997f85800029958.html" target="_blank" rel="noreferrer">Villkor för att vara en allmännyttig ideell förening</a>. This page is a watch, not tax advice — the accountant decides the classes.
        </div>
      </div>
    </main>
  );
}

function inYear(date: string, year: number, startMonth: number): boolean {
  const y = Number(date.slice(0, 4)), m = Number(date.slice(5, 7));
  return (m >= startMonth ? y : y - 1) === year;
}

function BankLine({ t, year, categories }: { t: Tx; year: number; categories: Cat[] }) {
  const who = t.counterparty || t.message || "";
  return (
    <form action={setBankCategory} className="row" style={{ gap: 10, flexWrap: "wrap", borderTop: "1px solid var(--line)", paddingTop: 8 }}>
      <input type="hidden" name="tx_id" value={t.id} />
      <input type="hidden" name="year" value={year} />
      <div style={{ flex: "1 1 240px" }} className="small">
        <span className="muted">{shortDate(parseISODate(t.booked_on))}</span> <b>{kr(t.amount_sek)}</b> · {t.title}{who ? <span className="muted"> · {who}</span> : null}
        {t.own_notes ? <div className="muted">{t.own_notes}</div> : null}
      </div>
      <select name="category_code" defaultValue={t.category_code ?? ""} className="inline" aria-label="Income category">
        <option value="">— not an income / not sorted —</option>
        {categories.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
      </select>
      <SubmitButton className="btn line sm" pendingText="Saving…">Save</SubmitButton>
    </form>
  );
}
