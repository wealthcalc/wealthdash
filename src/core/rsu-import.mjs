/* ======================================================================
   RSU/RSA CSV import — pure parsing logic for Wells Fargo/Shareworks-style
   exports. Two genuinely different real export shapes are supported, auto-
   detected from the header row by buildRsuImport() so the caller (ImportTab)
   never has to know which one it got:

   1. RELEASE HISTORY ("restricted stock units"/"restricted stock awards"):
      "Plan Description"/"Plan", "Instrument", "Grant Date" (UK-style
      "11 Jan 2023"), "Allocation quantity", "Released quantity",
      "Quantity to cover tax", "Net quantity", "Archive status" — past,
      already-released tranches. No per-row vest date, only the original
      grant date, so every vest event is dated on the grant date (flagged
      via a warning). See buildRsuReleaseImport()/mapRsuCsvRow() below.

   2. VESTING SCHEDULE ("Grant Year" export): "Grant Year", "Plan
      Description", "Contribution type" ("Award" | "Notional dividend"),
      "Grant Date", "Available from", "Quantity", "Estimated value",
      "Estimated value (unit)" — forward-looking, still-unvested tranches,
      PLUS notional dividend-equivalent shares accruing on them before
      vest. Confirmed against a real export: this one DOES carry a real
      per-tranche vest date ("Available from"), so it's used directly
      rather than falling back to the grant date. See
      buildRsuScheduleImport()/mapRsuScheduleRow() below for the one real
      wrinkle in this format — "Grant Date" means something different
      depending on the row's Contribution type.

   Neither format has a ticker column — the importer accepts a user-
   supplied ticker (pre-filled from the uploaded filename, e.g. "WFC" out
   of "...Wells Fargo WFC (NYS).csv", but always editable) — and neither
   ever gets a fabricated share price: cost-basis/FMV fields this app
   wasn't actually given (an estimate at report-generation time is not the
   same as the real FMV on the actual vest date) are left null rather than
   guessed.
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

// Which of the two real export shapes a parsed CSV is, decided from the
// header row alone (Papa.parse's per-row objects all share the same keys).
// "schedule" is checked first since it's the more specific signature
// (either header is unique to it); "release" needs its own distinguishing
// column rather than being the bare fallback, so a genuinely unrecognised
// file doesn't silently get treated as one format or the other.
export function detectRsuCsvFormat(rows) {
  const keys = new Set(Object.keys((rows && rows[0]) || {}));
  if (keys.has("Available from") || keys.has("Contribution type")) return "schedule";
  if (keys.has("Allocation quantity")) return "release";
  return null;
}

/* --------------------------- format 1: release history -------------------------- */

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
export function buildRsuReleaseImport(rows, { ticker = "" } = {}) {
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

/* --------------------------- format 2: vesting schedule -------------------------- */

// One parsed CSV row -> { planLabel, contributionType, grantDateRaw, vestDate,
// quantity, estimatedValueGBP } or null if unusable. `grantDateRaw` is
// parsed straight off the row's "Grant Date" column but its MEANING depends
// on contributionType (see buildRsuScheduleImport) — this function doesn't
// try to resolve that, just extracts what's on the row.
export function mapRsuScheduleRow(row) {
  const planLabel = (row["Plan Description"] ?? "").trim();
  const contributionType = (row["Contribution type"] ?? "").trim() || "Award";
  const grantDateRaw = parseUkDate(row["Grant Date"]);
  const vestDate = parseUkDate(row["Available from"]);
  const quantity = parseQty(row["Quantity"]);
  const estimatedValueGBP = parseQty(row["Estimated value"]);
  if (!planLabel || !vestDate || !quantity) return null;
  return { planLabel, contributionType, grantDateRaw, vestDate, quantity, estimatedValueGBP };
}

// rows/ticker: same contract as buildRsuReleaseImport(); same output shape
// too, so the caller can treat either format identically once built.
//
// The one real wrinkle in this format, confirmed against a real export:
// "Grant Date" means something different depending on the row's
// Contribution type. On an "Award" row it's the tranche's actual original
// grant date. On a "Notional dividend" row (a dividend-equivalent accrual
// on not-yet-vested shares) it's the DIVIDEND's record/payment date
// instead — e.g. a grant labelled "1/11/2023 RSU CRD Award" has an Award
// row with Grant Date "11 Jan 2023", but its sibling Notional dividend rows
// carry Grant Date "1 Jun 2026" / "1 Mar 2026" (real WFC dividend dates,
// nowhere near the actual grant). So the true grant date for each plan
// label is resolved from that label's OWN "Award" row(s) first, and only
// applied to its Notional dividend rows afterwards — never taken at face
// value off a dividend row. A plan label with no Award row at all in this
// file (only Notional dividend rows present) has no reliable grant date to
// resolve against; its own raw date is used as a flagged best-effort
// fallback rather than dropping the row.
//
// "Available from" IS a reliable real per-tranche vest date in this
// format (unlike the release-history export), so it's used directly for
// every vest event, Award or Notional dividend alike — no grant-date
// fallback needed there. "Estimated value" is a report-generation-time
// projection, not the actual FMV on the real vest date, so it's carried
// only as an informational note, never written into priceNative/fxRate
// (which feed real cost-basis maths in core/rsu.mjs).
export function buildRsuScheduleImport(rows, { ticker = "" } = {}) {
  const warnings = [];
  const tk = (ticker || "").toUpperCase().trim();
  if (!tk) warnings.push("No ticker set — enter the ticker this grant is in (e.g. WFC) before importing.");

  const mappedWithIdx = (rows || []).map((row, i) => ({ i, r: mapRsuScheduleRow(row) })).filter((x) => x.r);
  const skipped = (rows || []).length - mappedWithIdx.length;
  if (skipped) warnings.push(`${skipped} row(s) skipped — missing plan label, available-from date, or quantity.`);

  const grantDateByLabel = new Map();
  for (const { r } of mappedWithIdx) {
    if (r.contributionType.toLowerCase() === "award" && r.grantDateRaw && !grantDateByLabel.has(r.planLabel)) {
      grantDateByLabel.set(r.planLabel, r.grantDateRaw);
    }
  }

  const grantsByKey = new Map();
  const events = [];
  let fallbackUsed = false;

  for (const { i, r } of mappedWithIdx) {
    const known = grantDateByLabel.get(r.planLabel);
    const grantDate = known || r.grantDateRaw;
    if (!known && r.grantDateRaw) fallbackUsed = true;
    if (!grantDate) continue; // nothing at all to key this row's grant off — don't fabricate one

    const key = `${r.planLabel}|${grantDate}`;
    if (!grantsByKey.has(key)) grantsByKey.set(key, { key, ticker: tk, grantDate, note: r.planLabel });
    const isDividend = r.contributionType.toLowerCase().includes("dividend");
    const valueStr = r.estimatedValueGBP != null ? `£${r.estimatedValueGBP}` : "unknown";
    events.push({
      grantKey: key, type: "vest", date: r.vestDate, shares: r.quantity, priceNative: null, fxRate: null,
      note: `${isDividend ? "Notional dividend" : "Award tranche"} — estimated value ${valueStr} at report date, not actual vest-date FMV`,
      sourceRow: i,
    });
  }

  if (mappedWithIdx.length) {
    warnings.push("Estimated values in this export are report-date projections, not the actual FMV at vest — price is left blank on every event; enter the real FMV once each tranche actually vests.");
  }
  if (fallbackUsed) {
    warnings.push("Some rows' true grant date couldn't be confirmed from an \"Award\" row for that plan in this file — their own date column was used as a best-effort grant date instead; double-check it on the RSU tab.");
  }

  return { grants: [...grantsByKey.values()], events, warnings };
}

/* --------------------------------- dispatcher --------------------------------- */

// Auto-detects which of the two real export shapes `rows` is and delegates
// to the matching builder — the caller (ImportTab) never has to know or
// choose which format it received. An unrecognised header set (neither
// signature column present) falls back to the release-history parser,
// which will itself report "0 rows usable" via its own skipped-row warning
// rather than throwing — the same "degrade to a clear message, don't crash"
// behaviour as every other importer in this app.
export function buildRsuImport(rows, opts = {}) {
  const format = detectRsuCsvFormat(rows);
  return format === "schedule" ? buildRsuScheduleImport(rows, opts) : buildRsuReleaseImport(rows, opts);
}
