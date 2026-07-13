/* ======================================================================
   PRIVATE-INVESTMENT IMPORT — pure parsers for the two formats a venture
   LP / EIS platform (e.g. Seedrs) hands you, turned into the capital-call /
   distribution EVENTS that core/private-investments.mjs already models. Both
   are per-holding: you're looking at one fund's page when you copy its data,
   so the parsed rows attach to whichever holding you paste them onto. Pure
   and React-free; runs under node --test.

   1. TRANSACTION CSV — "Date,Transaction,Amount,Shares,Share Price,Type":
        Investment  -> a capital "call" (money you put in / was drawn down)
        Extinguish  -> a "distribution_capital" (return of capital — e.g.
                       Seedrs Re-Investment Cash: funds returned to the
                       nominee from a wind-down/loan-note repayment; a
                       deliberate mapping, confirmed against a real Passion
                       Capital notice, not a guess)
      Any other Transaction word is skipped and reported, never silently
      coerced into a call. Amounts are GBP (this importer is GBP-only).

      Genuine in-file duplicates are PRESERVED: some platforms legitimately
      list two identical same-day contributions, and halving them would
      understate cost basis. Idempotency across RE-imports is handled instead
      by reconcileImportRows (a multiset diff against what's already in the
      ledger), so re-pasting the same export doesn't double anything while a
      real pair of identical rows still both land on the first import.

   2. DISTRIBUTION RECEIPT (paste) — the "Distribution Summary" block:
        Distribution Summary
        <fund name>
        Total units held / <n>
        Returns per unit  / £<x>
        Gross return      / £<amount>
        Net return        / £<amount>
      There's no date in the receipt, so the UI supplies one (defaulting to
      today), and — because a distribution can be a return OF capital or an
      income distribution, which this receipt doesn't disambiguate — the UI
      asks capital-vs-income per the user's choice rather than this parser
      guessing. So this returns the parsed figures only; classification and
      date live in the UI layer.
   ====================================================================== */

// First numeric value in a string, tolerant of currency symbols, thousands
// separators, quotes, and a leading "label:" prefix ("Net return: £1,250.00").
function parseMoney(s) {
  if (s == null) return NaN;
  const m = String(s).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : NaN;
}

// Minimal CSV line splitter that respects double-quoted fields (the Type
// column arrives quoted, e.g. "Fund"). Good enough for these flat exports;
// no embedded newlines to worry about.
function splitCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') q = false; else cur += c; }
    else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

const TXN_TYPE_MAP = { investment: "call", extinguish: "distribution_capital" };
const round2 = (x) => Math.round((+x || 0) * 100) / 100;

// text -> { rows: [{date, type, amount, transaction}], skipped: [{line, reason}], warnings: [] }
export function parseInvestmentCsv(text) {
  const rows = [], skipped = [], warnings = [];
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const f = splitCsvLine(line);
    // Header row (Date,Transaction,Amount,...) — skip, don't report as an error.
    if (/^date$/i.test(f[0] || "") && f.some((x) => /^transaction$/i.test(x))) continue;
    const dateRaw = (f[0] || "").trim();
    const transaction = (f[1] || "").replace(/["']/g, "").trim();
    const amount = parseMoney(f[2]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw)) { skipped.push({ line, reason: "no valid ISO date" }); continue; }
    const type = TXN_TYPE_MAP[transaction.toLowerCase()];
    if (!type) { skipped.push({ line, reason: `unrecognised transaction "${transaction || "(blank)"}"` }); continue; }
    if (!(amount > 0)) { skipped.push({ line, reason: "amount missing or not positive" }); continue; }
    rows.push({ date: dateRaw, type, amount: round2(amount), transaction });
  }
  return { rows, skipped, warnings };
}

// text -> { fund, unitsHeld, returnPerUnit, gross, net, amount } | { error }
// `amount` is the figure to record (Net return preferred, Gross as fallback).
export function parseDistributionPaste(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { error: "Nothing to parse — paste the distribution summary." };

  // A label may sit on its own line with the value on the next line, OR on
  // the same line separated by a colon/tab ("Net return: £229.37"). Handle both.
  const findValue = (label) => {
    for (let i = 0; i < lines.length; i++) {
      const norm = lines[i].toLowerCase().replace(/[:\t]/g, " ").replace(/\s+/g, " ").trim();
      if (norm === label) return lines[i + 1] ?? null;               // value on next line
      if (norm.startsWith(label + " ")) return lines[i].slice(lines[i].toLowerCase().indexOf(label) + label.length); // same line
    }
    return null;
  };

  const unitsHeld = parseMoney(findValue("total units held"));
  const returnPerUnit = parseMoney(findValue("returns per unit"));
  const gross = parseMoney(findValue("gross return"));
  const net = parseMoney(findValue("net return"));

  let fund = null;
  const idx = lines.findIndex((l) => /^distribution summary$/i.test(l));
  if (idx >= 0 && lines[idx + 1]) fund = lines[idx + 1];

  const amount = Number.isFinite(net) ? net : (Number.isFinite(gross) ? gross : NaN);
  if (!Number.isFinite(amount)) return { error: "Couldn't find a Net return or Gross return amount in that text." };

  return {
    fund,
    unitsHeld: Number.isFinite(unitsHeld) ? unitsHeld : null,
    returnPerUnit: Number.isFinite(returnPerUnit) ? returnPerUnit : null,
    gross: Number.isFinite(gross) ? gross : null,
    net: Number.isFinite(net) ? net : null,
    amount: round2(amount),
  };
}

// Multiset diff: keep every incoming row EXCEPT as many as already exist in
// the ledger for the same key (so a genuine in-file duplicate pair both
// import the first time, but re-pasting the same file adds nothing). `keyFn`
// reduces a row/event to a comparable string; returning null opts a row out
// of matching entirely.
export function reconcileImportRows(newRows, existing = [], keyFn) {
  const counts = new Map();
  for (const e of existing) {
    const k = keyFn(e);
    if (k == null) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const rows = [];
  let skipped = 0;
  for (const r of newRows) {
    const k = keyFn(r);
    if (k != null && counts.get(k) > 0) { counts.set(k, counts.get(k) - 1); skipped++; continue; }
    rows.push(r);
  }
  return { rows, skipped };
}
