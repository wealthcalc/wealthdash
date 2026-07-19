/* ======================================================================
   BANK / CARD STATEMENT IMPORT — CSV in, spending rows out.

   Built to survive the fact that UK banks disagree about everything:
   header rows (HSBC's personal export often has NONE), date order
   (25/12/2026 vs 2026-12-25 vs "25 Dec 2026"), and — the one that
   silently corrupts a budget — SIGN CONVENTION.

   The sign problem, stated plainly: on a CURRENT ACCOUNT statement,
   spending is negative (money left). On a CREDIT CARD statement, spending
   is usually POSITIVE (the charge increased what you owe) and payments to
   the card are negative. Import both with one rule and half your data is
   inverted, which shows up as a budget that says you earned £4,000 at
   Tesco. So `signConvention` is explicit per profile, and the preview
   shows what the parser decided before anything is saved — the user can
   flip it if a statement disagrees.

   Internal convention (matching core/budget.mjs): SPEND IS POSITIVE,
   refunds and credits NEGATIVE.

   PROFILE HONESTY: the HSBC and Amex profiles here are built from the
   common shapes of their UK personal exports, not from a verified sample
   of the user's own files. Column auto-detection is therefore the primary
   mechanism and the profile is a hint — if a bank changes its export,
   detection still works off the header text, and if there's no header at
   all, positional fallback handles the classic date/description/amount
   triple. Every parse returns `warnings`, and the UI previews rows before
   committing.

   Pure and node-tested (statement-import.test.mjs).
   ====================================================================== */
import { parseCSVRows } from "./ibkr-import.mjs";

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

// UK statements are DD/MM — never MM/DD. Assuming otherwise silently
// mangles every date before the 13th of a month, which is most of them,
// so this deliberately does NOT try to be clever about US formats.
export function parseStatementDate(s) {
  const t = String(s || "").trim().replace(/^["']|["']$/g, "");
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  let m = t.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/);
  if (m) {
    const [, d, mo, yr] = m;
    const y = yr.length === 2 ? `20${yr}` : yr;
    return `${y}-${mo.padStart(2, "0")}-${d.padStart(2, "0")}`;
  }
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})$/);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return null;
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${mo}-${m[1].padStart(2, "0")}`;
  }
  return null;
}

// "£1,234.56", "1234.56 CR", "(42.10)" (parenthesised negative), "-42.10"
export function parseAmount(s) {
  let t = String(s ?? "").trim();
  if (!t) return null;
  let sign = 1;
  if (/^\(.*\)$/.test(t)) { sign = -1; t = t.slice(1, -1); }
  if (/\bCR$/i.test(t)) { sign = -sign; t = t.replace(/\bCR$/i, ""); }
  if (/\bDR$/i.test(t)) { t = t.replace(/\bDR$/i, ""); }
  t = t.replace(/[£$€,\s]/g, "");
  const v = parseFloat(t);
  return Number.isFinite(v) ? v * sign : null;
}

export const PROFILES = {
  // Spending arrives POSITIVE on a card statement (a charge increases the
  // balance owed); payments to the card come through negative.
  amex: { label: "American Express", signConvention: "spend-positive", account: "Amex" },
  // Current-account exports: spending is money OUT, i.e. negative.
  hsbc: { label: "HSBC", signConvention: "spend-negative", account: "HSBC" },
  // Generic: let detection decide (see detectSign below).
  auto: { label: "Auto-detect", signConvention: "auto", account: "" },
};

const norm = (s) => String(s || "").trim().toLowerCase();
const DATE_H = ["date", "transaction date", "date processed", "posted date", "value date"];
const DESC_H = ["description", "details", "transaction details", "narrative", "merchant", "payee", "reference"];
const AMT_H = ["amount", "value", "transaction amount", "amount (gbp)", "money out", "debit"];

// Which columns hold date/description/amount, and where does the data
// start? Statements routinely open with a preamble ("Your statement for
// account 1234", blank lines, an address block), so this SCANS for the
// header rather than assuming row 0 — the same lesson the Fidelity
// importer learned. Falls back to positional detection for headerless
// exports (HSBC's classic download), reading the data itself: the column
// that parses as a date, the one that parses as a number, and the widest
// text column. `headerIndex` is -1 when there's no header row.
export function detectColumns(rows) {
  const find = (cells, names) => cells.findIndex((c) => names.includes(c));
  // 1. Look for a real header row anywhere in the first few rows.
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = (rows[i] || []).map(norm);
    if (parseStatementDate(rows[i]?.[0]) != null) break; // data starts here — no header
    const date = find(cells, DATE_H), amount = find(cells, AMT_H);
    if (date >= 0 && amount >= 0) {
      const desc = find(cells, DESC_H);
      const credit = find(cells, ["credit", "money in", "paid in"]);
      return { date, desc: desc >= 0 ? desc : 1, amount, credit: credit >= 0 ? credit : null, hasHeader: true, headerIndex: i };
    }
  }
  // 2. No header: find the first row that looks like a transaction and
  // detect positionally from it.
  const probeIndex = rows.findIndex((r) => (r || []).some((c) => parseStatementDate(c) != null));
  const probe = rows[probeIndex] || [];
  const date = probe.findIndex((c) => parseStatementDate(c) != null);
  const amount = probe.findIndex((c, i) => i !== date && parseAmount(c) != null && /\d/.test(String(c)));
  let best = -1, bestLen = 0;
  probe.forEach((c, i) => {
    if (i === date || i === amount) return;
    const len = String(c || "").trim().length;
    if (len > bestLen) { bestLen = len; best = i; }
  });
  return { date, desc: best, amount, credit: null, hasHeader: false, headerIndex: -1, dataStart: Math.max(0, probeIndex) };
}

// When the profile says "auto": a statement whose spend is negative will
// have MOST rows negative (you spend more often than you're paid). This
// is a heuristic and says so — the UI shows the decision and lets the
// user flip it, rather than burying it.
export function detectSign(amounts) {
  const neg = amounts.filter((a) => a < 0).length;
  const pos = amounts.filter((a) => a > 0).length;
  if (!neg && !pos) return { convention: "spend-positive", confident: false };
  return neg > pos
    ? { convention: "spend-negative", confident: neg >= pos * 2 }
    : { convention: "spend-positive", confident: pos >= neg * 2 };
}

// Stable id for dedupe: same date + normalised description + amount +
// account is the same transaction. Statements get re-downloaded with
// overlapping windows constantly, so re-importing must be safe.
export function statementKey(t) {
  return [t.date, String(t.description || "").trim().toUpperCase().replace(/\s+/g, " "), (+t.amount).toFixed(2), t.account || ""].join("|");
}

export function dedupeStatement(incoming, existing = []) {
  const seen = new Set(existing.map(statementKey));
  const rows = [], duplicates = [];
  for (const t of incoming) {
    const k = statementKey(t);
    if (seen.has(k)) { duplicates.push(t); continue; }
    seen.add(k); rows.push(t);
  }
  return { rows, duplicates };
}

// text: raw CSV. profile: key of PROFILES. Returns
// { rows, warnings, meta: { columns, signConvention, detected } }.
export function parseStatement(text, { profile = "auto", account = "" } = {}) {
  const p = PROFILES[profile] || PROFILES.auto;
  const all = parseCSVRows(String(text || "").trim()).filter((r) => r.some((c) => String(c || "").trim() !== ""));
  const warnings = [];
  if (!all.length) return { rows: [], warnings: ["The file is empty or isn't readable as CSV."], meta: null };

  const cols = detectColumns(all);
  if (cols.date < 0 || cols.amount < 0) {
    return {
      rows: [], meta: { columns: cols },
      warnings: ["Couldn't find a date column and an amount column. Expected something like Date, Description, Amount — check the file is a transaction export rather than a summary or PDF-converted statement."],
    };
  }

  const body = cols.hasHeader ? all.slice(cols.headerIndex + 1) : all.slice(cols.dataStart || 0);
  const parsed = [];
  let skipped = 0;
  for (const r of body) {
    const date = parseStatementDate(r[cols.date]);
    let amount = parseAmount(r[cols.amount]);
    // Split debit/credit columns: a value in `credit` is money in.
    if (cols.credit != null && (amount == null || amount === 0)) {
      const cr = parseAmount(r[cols.credit]);
      if (cr != null) amount = -Math.abs(cr);
    }
    if (!date || amount == null || amount === 0) { skipped++; continue; }
    parsed.push({ date, description: String(r[cols.desc] ?? "").trim(), raw: amount });
  }
  if (!parsed.length) {
    return { rows: [], meta: { columns: cols }, warnings: [`No usable rows found (${skipped} row(s) had no readable date/amount).`] };
  }

  const detected = detectSign(parsed.map((x) => x.raw));
  const convention = p.signConvention === "auto" ? detected.convention : p.signConvention;
  if (p.signConvention === "auto" && !detected.confident) {
    warnings.push("Couldn't confidently tell whether spending is positive or negative in this file — check a few rows in the preview and flip the setting if they're inverted.");
  }
  // Normalise into "spend is positive".
  const flip = convention === "spend-negative" ? -1 : 1;
  const rows = parsed.map((x) => ({
    date: x.date,
    description: x.description,
    amount: Math.round(x.raw * flip * 100) / 100,
    account: account || p.account || "",
  }));

  if (skipped) warnings.push(`${skipped} row(s) skipped — no readable date or amount (statement headers, balance lines and blank rows are expected here).`);
  const spendCount = rows.filter((r) => r.amount > 0).length;
  if (spendCount === 0) warnings.push("Every row came through as a credit/refund, which usually means the sign convention is inverted for this file.");

  return {
    rows,
    warnings,
    meta: {
      columns: cols, signConvention: convention, detected,
      profile, count: rows.length, spendCount,
      dateRange: rows.length ? [rows.reduce((m, r) => (r.date < m ? r.date : m), rows[0].date), rows.reduce((m, r) => (r.date > m ? r.date : m), rows[0].date)] : null,
    },
  };
}
