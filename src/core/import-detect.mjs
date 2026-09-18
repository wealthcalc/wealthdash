/* ======================================================================
   IMPORT FORMAT DETECTION — look at a file and say what it is, so the
   user drops it once instead of choosing a parser first.

   The Import tab asked for the source (seven pills), then the wrapper,
   then a sub-mode, before a file could be pasted. Every supported format
   has a distinctive header row, and one of them (RSU) already had its own
   detector — so the choice was always answerable from the file itself.

   This module only CLASSIFIES; the existing parsers do the parsing. Pure
   and node-tested (import-detect.test.mjs). Returns
     { kind, confidence, reason, headers }
   where kind is one of:
     ibkr        Interactive Brokers CSV (Flex Query or Activity Statement)
     fidelity    Fidelity UK transaction history
     rsu         Shareworks-style vest release / vesting schedule
     statement   bank / card statement (Amex, HSBC…) — Budget's importer
     dividends   a dividend/interest list (date, ticker, type, amount)
     positions   a holdings snapshot (ticker/ISIN + quantity, no trade side)
     trades      a generic trade list (date, ticker, side, quantity, amount)
     workbook    an Excel workbook (iShares ERI) — by extension only
     unknown
   ====================================================================== */

const norm = (h) => String(h ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// First line that looks like a CSV header: at least three comma-separated
// cells, mostly non-numeric. Fidelity prefixes ~6 metadata rows; IBKR
// Activity Statements interleave section headers — hence the scan.
export function findHeaderLine(text, { maxScan = 40 } = {}) {
  const lines = String(text || "").split(/\r?\n/).slice(0, maxScan);
  for (let i = 0; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 3) continue;
    const wordy = cells.filter((c) => c.trim() && !/^[-+\d.,£$%\s/]+$/.test(c.trim())).length;
    if (wordy >= Math.max(3, Math.ceil(cells.length * 0.6))) return { index: i, cells: cells.map((c) => c.trim()) };
  }
  return null;
}

function splitCsvLine(line) {
  const out = []; let cur = "", q = false;
  for (const ch of String(line || "")) {
    if (ch === '"') { q = !q; continue; }
    if (ch === "," && !q) { out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const HAS = (set, ...names) => names.some((n) => set.has(norm(n)));
const ANY = (set, re) => [...set].some((h) => re.test(h));

export function detectImportFormat(text, { filename = "" } = {}) {
  const fn = String(filename || "").toLowerCase();
  if (/\.(xlsx|xls|xlsm)$/.test(fn)) return { kind: "workbook", confidence: 0.9, reason: "Excel workbook — treated as an issuer ERI report (iShares).", headers: [] };

  const found = findHeaderLine(text);
  if (!found) return { kind: "unknown", confidence: 0, reason: "No header row found in the first 40 lines.", headers: [] };
  const headers = found.cells;
  const set = new Set(headers.map(norm));
  const done = (kind, confidence, reason) => ({ kind, confidence, reason, headers, headerIndex: found.index });

  // --- vendor-specific signatures first (most specific wins) ---
  if (HAS(set, "Product Wrapper") && HAS(set, "Transaction type") && HAS(set, "Order date", "Completion date")) {
    return done("fidelity", 0.98, "Fidelity UK transaction history (Product Wrapper / Transaction type / Order date).");
  }
  if (HAS(set, "Available from") || HAS(set, "Contribution type") || HAS(set, "Allocation quantity")) {
    return done("rsu", 0.95, "Shareworks-style RSU export (Allocation quantity / Available from).");
  }
  if (HAS(set, "CurrencyPrimary", "FXRateToBase", "IBCommission", "ListingExchange", "AssetClass", "TradeID", "ClientAccountID") && HAS(set, "Symbol")) {
    return done("ibkr", 0.95, "Interactive Brokers columns (CurrencyPrimary / FXRateToBase / IBCommission).");
  }
  // IBKR Activity Statement CSVs start each row with a section name — no
  // real header line, but "Trades,Header,…" is unmistakable.
  if (/^(Statement|Trades|Account Information),(Header|Data),/m.test(String(text || "").slice(0, 4000))) {
    return done("ibkr", 0.9, "Interactive Brokers Activity Statement (sectioned rows).");
  }

  // --- generic shapes, by which columns exist ---
  const hasDate = ANY(set, /date|settl|posted/);
  const hasTicker = ANY(set, /^(ticker|symbol|instrument|stock|epic|code|isin|sedol)$/) || HAS(set, "ISIN");
  const hasSide = ANY(set, /^(side|action|buysell|bs|transactiontype|type)$/) || ANY(set, /buy.*sell/);
  const hasQty = ANY(set, /^(qty|quantity|shares|units|nominal|holding|position)$/) || ANY(set, /quantity|units/);
  const hasAmount = ANY(set, /amount|proceeds|consideration|value|cost|total|net/);
  const hasDesc = ANY(set, /^(description|details|narrative|merchant|payee|transactiondetails)$/);
  const hasKind = ANY(set, /^(type|kind|incometype|paymenttype)$/) && ANY(set, /dividend|interest|income/) || HAS(set, "Dividend", "Interest");

  // A bank/card statement: dated rows with a free-text description and an
  // amount, and NO instrument column. Budget's importer owns these.
  if (hasDate && hasDesc && hasAmount && !hasTicker && !hasQty) {
    return done("statement", 0.85, "Dated rows with a description and amount, no instrument — a bank or card statement (Budget ▸ Import statements).");
  }
  // Holdings snapshot: instrument + quantity, but no trade side and usually
  // no date — what a broker's "portfolio" or "valuation" export looks like.
  if (hasTicker && hasQty && !hasSide && !hasDate) {
    return done("positions", 0.85, "Instrument and quantity with no side or date — a holdings snapshot (reconcile against the ledger).");
  }
  if (hasTicker && hasQty && !hasSide && hasDate && !hasAmount) {
    return done("positions", 0.7, "Instrument and quantity, no side — probably a holdings snapshot.");
  }
  // Dividend/interest list: dated payments per instrument with NO quantity.
  // The header alone rarely says "dividend" (it's usually just "Type"), so
  // the first few data rows are consulted for the words.
  const sample = String(text || "").slice(0, 4000);
  const looksIncome = /\b(dividend|interest|coupon|distribution)\b/i.test(sample);
  const looksTraded = /\b(buy|sell|bought|sold|purchase|disposal)\b/i.test(sample);
  if (hasDate && hasTicker && hasAmount && !hasQty && (hasKind || looksIncome || !looksTraded)) {
    return done("dividends", looksIncome ? 0.85 : 0.6, "Dated payments per instrument with no quantity — a dividend/interest list.");
  }
  // Generic trade list.
  if (hasDate && hasTicker && hasQty && (hasSide || hasAmount)) {
    return done("trades", 0.75, "Dated trades with instrument, quantity and amount — mapped column by column.");
  }
  return done("unknown", 0.2, `Couldn't place these columns: ${headers.slice(0, 8).join(", ")}${headers.length > 8 ? "…" : ""}`);
}

/* ---------------------- saved column-mapping profiles ------------------ */
// A profile remembers how one broker's export maps onto the app's fields,
// keyed by the export's header signature so the same file shape is
// recognised next time without a name having to be typed. Pure helpers;
// the profiles themselves are persisted state.
export const headerSignature = (headers = []) => headers.map(norm).filter(Boolean).sort().join("|");

export function saveProfile(profiles = {}, { name, kind, headers, map }) {
  const n = String(name || "").trim();
  if (!n) throw new Error("A profile needs a name");
  return { ...profiles, [n]: { name: n, kind: kind || "trades", signature: headerSignature(headers), map: { ...map }, savedAt: new Date().toISOString() } };
}

// Exact signature match first; else the profile whose mapped columns all
// exist in this file (a wider export of the same shape still fits).
export function matchProfile(profiles = {}, headers = [], kind = null) {
  const sig = headerSignature(headers);
  const set = new Set(headers.map(norm));
  const list = Object.values(profiles || {}).filter((p) => !kind || p.kind === kind);
  const exact = list.find((p) => p.signature === sig);
  if (exact) return { profile: exact, exact: true };
  const fits = list.find((p) => Object.values(p.map || {}).filter(Boolean).every((col) => set.has(norm(col))));
  return fits ? { profile: fits, exact: false } : null;
}

export function deleteProfile(profiles = {}, name) {
  const next = { ...profiles };
  delete next[name];
  return next;
}
