/* ======================================================================
   CSV / TEXT EXPORT — get the data OUT, for an accountant or a
   spreadsheet, in formats the JSON backup can't serve.

   The JSON backup is for round-tripping into this app; it's unreadable to
   anyone else and useless in Excel. These exports are the opposite: flat,
   headed, human- and spreadsheet-legible, and deliberately lossy (they're
   a view, not a restore point).

   CSV correctness is mostly about escaping, which naive string-joining
   gets wrong the first time a description contains a comma, a quote or a
   newline — and transaction descriptions contain all three. RFC 4180:
   wrap a field in quotes if it holds a comma, quote or newline, and
   double any internal quote. A leading =/+/-/@ is prefixed with a
   quote-and-apostrophe guard, because Excel interprets those as formulas
   ("CSV injection") — a real-world footgun for anything a bank names.

   Pure and node-tested (export-csv.test.mjs). Producing the actual file
   download is the UI's job (Blob + anchor); this only builds the string.
   ====================================================================== */

// One field, RFC-4180-escaped, with spreadsheet-formula neutralisation.
export function csvField(v) {
  if (v == null) return "";
  let s = String(v);
  // Neutralise formula-injection: Excel/Sheets treat a leading = + - @ as
  // a formula. Prefixing a single quote is the standard defang.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

// rows: array of arrays (first row is usually the header).
export function toCsv(rows) {
  return rows.map((r) => r.map(csvField).join(",")).join("\r\n");
}

// The transaction ledger as a flat CSV. Column set is fixed and explicit
// rather than "every key on the object", so a new internal field can't
// silently leak into an export an accountant reads.
export function ledgerCsv(txns = []) {
  const header = ["Date", "Side", "Ticker", "Wrapper", "Quantity", "GBP amount", "Fees", "Native ccy", "Account"];
  const body = [...txns]
    .filter((t) => t && t.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((t) => [
      t.date, t.side || "", t.ticker || "", t.wrapper || "",
      t.quantity ?? "", t.gbpAmount ?? "", t.fees ?? "",
      t.nativeCurrency || "", t.account || "",
    ]);
  return toCsv([header, ...body]);
}

// Dividends & interest ledger as CSV — the reconciliation view an
// accountant or a tax return actually needs.
export function incomeCsv(incomeEntries = []) {
  const header = ["Date", "Type", "Ticker", "Wrapper", "Amount (GBP)"];
  const body = [...incomeEntries]
    .filter((e) => e && e.date)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
    .map((e) => [e.date, e.kind || "", e.ticker || "", e.wrapper || "", e.amount ?? ""]);
  return toCsv([header, ...body]);
}

// A plain-text tax summary for a given UK tax year — the CGT and income
// figures, formatted to paste into a return or hand to an accountant.
// `data` is assembled by the caller from the app's own engines; this
// module only lays it out, so it can't disagree with the on-screen
// numbers. Deliberately text, not CSV: it's a document, not a dataset.
export function taxSummaryText({ taxYear, cgt = null, income = null, generatedOn } = {}) {
  const L = [];
  const gbp = (n) => (n == null ? "—" : `£${Math.round(+n).toLocaleString("en-GB")}`);
  L.push(`UK TAX SUMMARY — ${taxYear || "(tax year)"}`);
  if (generatedOn) L.push(`Generated ${generatedOn} · figures are an estimate to support your own filing, not tax advice`);
  L.push("");
  if (cgt) {
    L.push("CAPITAL GAINS (GIA disposals, HMRC share-identification rules)");
    L.push(`  Proceeds:            ${gbp(cgt.proceeds)}`);
    L.push(`  Gains:               ${gbp(cgt.gains)}`);
    L.push(`  Losses:              ${gbp(cgt.losses)}`);
    L.push(`  Net gain:            ${gbp(cgt.netGain)}`);
    L.push(`  Annual exempt amount:${gbp(cgt.allowance)}`);
    L.push(`  Taxable gain:        ${gbp(cgt.taxable)}`);
    if (cgt.disposals != null) L.push(`  Disposals:           ${cgt.disposals}`);
    L.push("");
  }
  if (income) {
    L.push("INVESTMENT INCOME (taxable, GIA — includes ERI)");
    L.push(`  Dividends:           ${gbp(income.dividends)}`);
    L.push(`  Interest:            ${gbp(income.interest)}`);
    L.push(`  Estimated dividend tax: ${gbp(income.dividendTax)}`);
    L.push(`  Estimated interest tax: ${gbp(income.interestTax)}`);
    L.push("");
  }
  if (!cgt && !income) L.push("No taxable CGT or investment income recorded for this year.");
  return L.join("\n");
}
