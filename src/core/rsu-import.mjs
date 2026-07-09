/* ======================================================================
   RSU/RSA vest-release CSV import — pure parsing logic for the Wells
   Fargo/Shareworks-style "restricted stock units" / "restricted stock
   awards" exports (confirmed against two real files: one plan label
   reused across multiple grant dates, one grant date reused across
   multiple plan labels — so grants are grouped by the PAIR, not either
   field alone).

   Real column set (both files, confirmed):
     "Plan Description" or "Plan", "Instrument", "Grant Date" (UK-style
     "11 Jan 2023"), "Allocation quantity", "Released quantity",
     "Quantity to cover tax", "Net quantity", "Archive status"

   No ticker column and no per-row vest/release date column exist in this
   export — only the original Grant Date. Two consequences, both handled
   honestly rather than guessed away:
     - Ticker has to come from outside the file. The importer accepts a
       user-supplied ticker (pre-filled from the uploaded filename, e.g.
       "WFC" out of "...Wells Fargo WFC (NYS).csv", but always editable).
     - Multiple rows sharing one plan label + grant date are separate
       vest tranches under the SAME grant, but this export doesn't say
       which date each tranche actually vested on — so each vest event
       is dated on the grant date, and a warning says so. The RSU tab
       already supports editing an event's date by hand afterwards.

   Allocation quantity = Quantity to cover tax + Net quantity (verified
   arithmetically against every row of both files) — i.e. shares sold
   automatically to cover income-tax withholding at vest. Each row
   therefore becomes a "vest" event for the gross Allocation quantity
   PLUS an automatic same-date "sale" event for the withheld quantity,
   so core/rsu.mjs's heldShares figure doesn't overstate what's actually
   still held (mirrors how core/rsu.mjs's own doc comments describe the
   vest+sale event model). Price/FMV is deliberately left blank — no
   price column exists in this export, and this app doesn't fabricate
   figures it wasn't given.
   ====================================================================== */

const MONTHS = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

// "11 Jan 2023" -> "2023-01-11". Returns null if unparseable.
export function parseUkDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (m) {
    const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (!mm) return null;
    return `${m[3]}-${mm}-${m[1].padStart(2, "0")}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return s;
  return null;
}

// "1,549" / "161.00000" / "" -> number or null. Never fabricates a sign.
export function parseQty(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/,/g, "").trim();
  if (!s || !/^\d+(\.\d+)?$/.test(s)) return null;
  return parseFloat(s);
}

// Best-effort ticker guess out of a filename like
// "restricted stock units-Wells Fargo WFC (NYS).csv" -> "WFC". Looks for
// an all-caps 1-6 letter token immediately before an opening parenthesis
// (the exchange suffix, e.g. "(NYS)"), which is where both real sample
// filenames put the ticker. Returns "" (not a guess) if nothing matches —
// the UI field is always user-editable regardless.
export function guessTickerFromFilename(fileName) {
  if (!fileName) return "";
  const m = String(fileName).match(/\b([A-Z]{1,6})\s*\(/);
  return m ? m[1] : "";
}

// One parsed CSV row -> { planLabel, grantDate, allocation, taxCover, netQty } or
// null if the row is missing the fields needed to build an event from it.
export function mapRsuCsvRow(row) {
  const planLabel = (row["Plan Description"] ?? row["Plan"] ?? "").trim();
  const grantDate = parseUkDate(row["Grant Date"]);
  const allocation = parseQty(row["Allocation quantity"]);
  const taxCover = parseQty(row["Quantity to cover tax"]) || 0;
  const netQty = parseQty(row["Net quantity"]);
  if (!planLabel || !grantDate || !allocation) return null;
  return { planLabel, grantDate, allocation, taxCover, netQty: netQty ?? Math.max(0, allocation - taxCover) };
}

// rows: Papa.parse-style array of objects keyed by header name (already
// parsed — this module stays dependency-free, same convention as
// core/pension-import.mjs). ticker: user-supplied/confirmed ticker applied
// to every grant from this file (this export has no per-row ticker).
// Returns { grants, events, warnings } where grants/events use a
// synthetic string `key` in place of a real id — the caller (ImportTab)
// resolves each key against any existing grant/event before assigning
// real uid()s, same two-phase pattern as the IBKR/pension importers'
// dedupeAgainstExisting() calls.
export function buildRsuImport(rows, { ticker = "" } = {}) {
  const warnings = [];
  const tk = (ticker || "").toUpperCase().trim();
  if (!tk) warnings.push("No ticker set — enter the ticker this grant is in (e.g. WFC) before importing.");

  // sourceRow tracks each event back to its originating row index in the
  // input `rows` array (post-filter indices would drift on re-parse, so
  // this is captured before the filter) — lets the caller offer per-row
  // delete in the import preview while still driving grant/event grouping
  // off the full, always-freshly-rebuilt row set.
  const mappedWithIdx = (rows || []).map((row, i) => ({ i, r: mapRsuCsvRow(row) })).filter((x) => x.r);
  const skipped = (rows || []).length - mappedWithIdx.length;
  if (skipped) warnings.push(`${skipped} row(s) skipped — missing plan label, grant date, or allocation quantity.`);

  const grantsByKey = new Map(); // `${planLabel}|${grantDate}` -> grant
  const events = [];
  let taxCoverTotal = 0;

  for (const { i, r } of mappedWithIdx) {
    const key = `${r.planLabel}|${r.grantDate}`;
    if (!grantsByKey.has(key)) grantsByKey.set(key, { key, ticker: tk, grantDate: r.grantDate, note: r.planLabel });
    events.push({ grantKey: key, type: "vest", date: r.grantDate, shares: r.allocation, priceNative: null, fxRate: null, sourceRow: i });
    if (r.taxCover > 0) {
      events.push({ grantKey: key, type: "sale", date: r.grantDate, shares: r.taxCover, priceNative: null, fxRate: null, note: "Sold to cover tax withholding", sourceRow: i });
      taxCoverTotal += r.taxCover;
    }
  }

  if (mappedWithIdx.length) {
    warnings.push("This export doesn't include a per-tranche vest date, only the original grant date — every vest event below is dated on the grant date. Edit exact vest dates on the RSU tab if you know them.");
  }
  if (taxCoverTotal > 0) {
    warnings.push(`${Math.round(taxCoverTotal * 100) / 100} share(s) across all rows were withheld to cover tax and recorded as automatic same-date sales, so held-share totals aren't overstated.`);
  }

  return { grants: [...grantsByKey.values()], events, warnings };
}
