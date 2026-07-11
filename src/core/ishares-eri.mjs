/* ======================================================================
   iShares/BlackRock "UK Reportable Income" workbook parser (one per fund
   umbrella — iShares Plc, iShares II-VII plc — one row per share class per
   accounting period, keyed by ISIN). Extracted VERBATIM from
   CgtDashboard.jsx; pure and node-tested (ishares-eri.test.mjs).

   Confirmed structure: Fund Umbrella Name | Fund Name | [Share Class Name]
   | ISIN | [HMRC share class reference] | Reporting Period | Currency |
   Statement Under Regulation 92(1)(e) | Excess of Reported Income per Unit
   | Fund Distribution Date | Meets definition of a Bond Fund for the
   period | Actual Distribution per Unit/Date - 1, 2, 3... (repeating,
   unused here). "Reporting Period" is a text range ("01 July 2024 to 30
   June 2025" / "01.12.2024 to 30.11.2025" / "01/03/2020 to 28/02/2021"
   depending on report year) — period end is the second date. "Meets
   definition of a Bond Fund" is the authoritative dividend-vs-interest
   signal per HMRC's offshore-fund ERI treatment rule. Column detection
   stays keyword-based (not fixed-position) since column order shifts
   between umbrellas and report years.
   ====================================================================== */

// Add n months to an ISO date, clamping to the target month's last day.
export const addMonthsISO = (s, n) => {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDayOfTarget));
  return target.toISOString().slice(0, 10);
};

const _isNorm = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
const _isHasAny = (h, ...words) => words.some((w) => h.includes(w));
const _IS_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const _pad2 = (n) => String(n).padStart(2, "0");
function _isParseDateText(s) {
  const t = String(s ?? "").trim(); if (!t) return "";
  let m = t.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/); // "31 May 2025"
  if (m) { const mo = _IS_MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${m[3]}-${_pad2(mo)}-${_pad2(+m[1])}`; }
  m = t.match(/^(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})$/); // "31/05/2025" or "31.05.2025" (dd/mm/yyyy)
  if (m) return `${m[3]}-${_pad2(+m[2])}-${_pad2(+m[1])}`;
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; // "2025-05-31"
  return "";
}
function _isExcelSerialToISO(n) {
  const num = +n; if (!isFinite(num)) return "";
  const ms = Math.round((num - 25569) * 86400 * 1000);
  const d = new Date(ms); return isNaN(d) ? "" : d.toISOString().slice(0, 10);
}
function _isCellToISO(v) {
  if (v == null || v === "") return "";
  if (v instanceof Date) return isNaN(v) ? "" : v.toISOString().slice(0, 10);
  if (typeof v === "number") return _isExcelSerialToISO(v);
  return _isParseDateText(v);
}
function _isRangeEndToISO(v) {
  const t = String(v ?? ""); const m = t.split(/\bto\b/i);
  if (m.length < 2) return ""; return _isParseDateText(m[m.length - 1]);
}
const _ISIN_RE = /\b[A-Z]{2}[A-Z0-9]{9}\d\b/;
export function findHeaderRow(aoa, maxScan = 15) {
  let best = -1, bestScore = -1;
  for (let r = 0; r < Math.min(maxScan, aoa.length); r++) {
    const row = aoa[r] || []; const cells = row.map((c) => _isNorm(c));
    const nonEmpty = cells.filter(Boolean).length; if (nonEmpty < 3) continue;
    const looksHeader = cells.some((c) => c === "isin" || c.includes("isin"));
    const score = nonEmpty + (looksHeader ? 10 : 0);
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}
export function guessColumnMap(headerRow) {
  const cells = (headerRow || []).map((c) => _isNorm(c));
  const find = (test) => { for (let i = 0; i < cells.length; i++) if (test(cells[i])) return i; return -1; };
  const findFundName = () => {
    let i = find((h) => _isHasAny(h, "fund name", "sub fund", "subfund"));
    if (i >= 0) return i;
    return find((h) => h.includes("fund") && h.includes("name"));
  };
  return {
    isin: find((h) => h === "isin" || h.includes("isin")),
    fundName: findFundName(),
    currency: find((h) => h === "currency" || h === "ccy" || h.includes("currency")),
    periodEnd: find((h) => _isHasAny(h, "period end", "accounting period end", "accounting date", "fund year end", "year end date", "distribution period end")),
    reportingPeriod: find((h) => h.includes("reporting period")),
    distributionDate: find((h) => h.includes("distribution") && h.includes("date") && !h.includes("actual")),
    eriPerUnit: find((h) => _isHasAny(h, "excess of reported income", "excess reportable income", "reportable income per", "eri per", "excess income per") || (h.includes("excess") && h.includes("income") && !h.includes("statement"))),
    bondFund: find((h) => h.includes("bond fund")),
    treatment: find((h) => _isHasAny(h, "income type", "type of income", "interest distribution", "dividend distribution", "excess type")),
  };
}
export function extractISharesRows(aoa, headerRowIdx, colMap, holdingIsins) {
  const out = [];
  for (let r = headerRowIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || []; const get = (idx) => (idx >= 0 && idx < row.length ? row[idx] : "");
    let isin = String(get(colMap.isin) ?? "").trim().toUpperCase();
    if (!isin && colMap.isin < 0) { const m = row.map((c) => String(c ?? "")).join(" ").match(_ISIN_RE); if (m) isin = m[0]; }
    if (!_ISIN_RE.test(isin)) continue;
    if (holdingIsins && holdingIsins.size && !holdingIsins.has(isin)) continue;
    const eriRaw = get(colMap.eriPerUnit);
    const eri = typeof eriRaw === "number" ? eriRaw : parseFloat(String(eriRaw).replace(/,/g, ""));
    if (!isFinite(eri) || eri <= 0) continue; // zero/blank rows (fully distributed, or metadata) carry no tax impact

    const periodEndISO = colMap.periodEnd >= 0 ? _isCellToISO(get(colMap.periodEnd))
      : colMap.reportingPeriod >= 0 ? _isRangeEndToISO(get(colMap.reportingPeriod)) : "";
    let distributionDateISO = colMap.distributionDate >= 0 ? _isCellToISO(get(colMap.distributionDate)) : "";
    if (!distributionDateISO && periodEndISO) distributionDateISO = addMonthsISO(periodEndISO, 6);

    const currencyRaw = String(get(colMap.currency) ?? "").trim().toUpperCase();
    let treatment = "dividend";
    if (colMap.bondFund >= 0) treatment = _isNorm(get(colMap.bondFund)).startsWith("yes") ? "interest" : "dividend";
    else if (colMap.treatment >= 0) treatment = _isNorm(get(colMap.treatment)).includes("interest") ? "interest" : "dividend";

    out.push({ isin, fundName: String(get(colMap.fundName) ?? "").trim(), currency: currencyRaw === "GBX" || currencyRaw === "GBP PENCE" ? "GBp" : (currencyRaw || "GBP"), periodEnd: periodEndISO, distributionDate: distributionDateISO, perShare: Math.round(eri * 1e6) / 1e6, treatment });
  }
  return out;
}
export function parseISharesWorkbook(sheets, holdingIsins) {
  return sheets.map((s) => {
    const headerRowIdx = findHeaderRow(s.aoa);
    if (headerRowIdx < 0) return { name: s.name, headerRowIdx: -1, colMap: null, headerCells: [], rows: [] };
    const headerCells = s.aoa[headerRowIdx] || [];
    const colMap = guessColumnMap(headerCells);
    const rows = colMap.eriPerUnit >= 0 || colMap.isin >= 0 ? extractISharesRows(s.aoa, headerRowIdx, colMap, holdingIsins) : [];
    return { name: s.name, headerRowIdx, colMap, headerCells, rows };
  });
}
