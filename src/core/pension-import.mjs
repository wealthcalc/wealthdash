/* ======================================================================
   Pension contribution/switch CSV import — pure parsing logic, shared by
   the Import tab's "Pension contributions" mode.

   Providers export this kind of history in genuinely different shapes —
   confirmed against two real files this session:
     Citi/L&G:  Effective Date,Transaction Type,Transaction Currency,Amount
                15/03/2026,Switch,,
                28/02/2025,Regular Contribution,GBP,"£1,234.56"
     Aviva:     Date,Symbol,Type,Currency,Amount
                2023-02-10,Pension,Employer Contribution,GBP,600.00
   Different header names, different date formats (DD/MM/YYYY vs
   YYYY-MM-DD), different amount formatting (£ and commas vs plain), and
   "Switch" rows that carry no cash amount at all (a fund-to-fund transfer,
   not a contribution) — all handled here rather than assumed uniform.
   ====================================================================== */

// "£1,234.56" / "600.00" / "-£42.10" / "" / null -> number or null.
// Never guesses a sign or magnitude it can't parse cleanly.
export function parseMoney(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const neg = /^-/.test(s) || /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[£$€,()]/g, "").replace(/^-/, "").trim();
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = parseFloat(cleaned);
  return neg ? -n : n;
}

// DD/MM/YYYY or YYYY-MM-DD -> YYYY-MM-DD (ISO). Returns null if unparseable.
export function parsePensionDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

// A "Switch" (fund-to-fund transfer) carries no net cashflow, so it's
// excluded from XIRR — it's an internal reallocation, not money moving into
// or out of the pension. Everything else with a genuine nonzero amount
// counts as a contribution-type cashflow (Regular/Employer Contribution,
// Adjustment, Phasing, or any provider-specific label not recognised as a
// switch — better to include an unrecognised-but-nonzero row than silently
// drop real contribution history because of label wording differences).
export function classifyPensionType(typeStr) {
  const t = String(typeStr || "").trim().toLowerCase();
  if (t.includes("switch")) return "switch";
  return "contribution";
}

// Guess column names across the header-naming variants seen so far.
export function guessPensionColumns(fields) {
  const find = (re) => fields.find((c) => re.test(c));
  return {
    date: find(/^date$|effective date/i),
    type: find(/^type$|transaction type/i),
    currency: find(/^currency$|transaction currency/i),
    amount: find(/^amount$/i),
  };
}

// row: a Papa.parse-style object keyed by header name. colMap: the guessed
// (or user-corrected) column mapping. provider: user-selected, since none
// of these exports reliably identify which scheme/provider they're from
// (Aviva's "Symbol" column is just a constant label, not a real symbol).
// Returns null for switches and unparseable/zero-amount rows — never a
// fabricated cashflow.
export function mapPensionRow(row, colMap, provider) {
  const date = parsePensionDate(row[colMap.date]);
  const type = classifyPensionType(row[colMap.type]);
  const ccy = (row[colMap.currency] || "GBP").trim() || "GBP";
  const amount = parseMoney(row[colMap.amount]);
  if (!date || type === "switch" || amount == null || amount === 0) return null;
  return { date, provider, type: row[colMap.type] || "Contribution", ccy, nativeAmount: amount };
}
