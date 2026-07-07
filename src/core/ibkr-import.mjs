/* ======================================================================
   IBKR CSV IMPORT (Flex Query + Activity Statement) -> trades + income.
   Extracted VERBATIM from CgtDashboard.jsx; pure and node-tested
   (ibkr-import.test.mjs). Behaviour is unchanged from the inlined version.
   ====================================================================== */

export function parseCSVRows(text) {
  const rows = []; let row = [], cell = "", q = false;
  const s = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}
const _ibnorm = (h) => h.toLowerCase().replace(/[^a-z0-9]/g, "");
const _ibnum = (x) => { if (x == null) return 0; const n = parseFloat(String(x).replace(/,/g, "")); return isFinite(n) ? n : 0; };
const _ibdate = (x) => {
  if (!x) return ""; const s = String(x).trim(); let m = s.match(/^(\d{4})(\d{2})(\d{2})$/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})\/(\d{2})\/(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`; return "";
};
const _IBSTOCK = new Set(["stk", "etf", "fund", "stocks", "equity", "closedendfund"]);
const _ibpick = (headerIndex) => (row, ...keys) => { for (const k of keys) { const i = headerIndex[k]; if (i != null && row[i] !== undefined) return row[i]; } return undefined; };
function _ibTrade(get, defaultWrapper, baseCurrency, warnings) {
  const symbol = (get("symbol", "underlyingsymbol") || "").trim().toUpperCase();
  const date = _ibdate(get("tradedate", "datetime", "date"));
  if (!symbol || !date) return null;
  const asset = _ibnorm(get("assetclass", "assetcategory") || "stk");
  if (asset && !_IBSTOCK.has(asset)) { warnings.push(`Skipped ${symbol} ${date}: asset class "${asset}" not supported.`); return null; }
  const qtyRaw = _ibnum(get("quantity"));
  const bs = (get("buysell") || "").trim().toUpperCase();
  const side = bs ? (bs.startsWith("S") ? "SELL" : "BUY") : (qtyRaw < 0 ? "SELL" : "BUY");
  const quantity = Math.abs(qtyRaw); if (!quantity) return null;
  const currency = (get("currencyprimary", "currency") || "GBP").trim().toUpperCase();
  const proceeds = _ibnum(get("proceeds")), commission = _ibnum(get("ibcommission", "commission", "commfee", "commissionandtax")), taxes = _ibnum(get("taxes", "tax"));
  const netcash = get("netcash");
  const native = Math.abs(netcash !== undefined && netcash !== "" ? _ibnum(netcash) + taxes : proceeds + commission + taxes);
  const fxToBase = _ibnum(get("fxratetobase", "fxrate"));
  const isin = (get("isin", "securityid") || "").trim().toUpperCase();
  let gbpAmount = null, fxRate = null, needsFx = false;
  if (currency === "GBP") { gbpAmount = native; fxRate = 1; }
  else if (baseCurrency === "GBP" && fxToBase) { gbpAmount = native * fxToBase; fxRate = fxToBase; }
  else needsFx = true;
  return { date, ticker: symbol, isin, side, quantity, nativeCurrency: currency, nativeAmount: native, fxRate, gbpAmount: gbpAmount == null ? null : Math.round(gbpAmount * 100) / 100, needsFx, wrapper: defaultWrapper };
}
function _ibCash(get, defaultWrapper, baseCurrency) {
  const typ = _ibnorm(get("type", "activitydescription", "description") || "");
  let kind = null;
  if (typ.includes("withholding")) return null;
  if (typ.includes("dividend") || typ.includes("inlieu") || typ.includes("paymentinlieu")) kind = "dividend";
  else if (typ.includes("interest")) kind = "interest"; else return null;
  const amount = _ibnum(get("amount")); if (amount <= 0) return null;
  const date = _ibdate(get("settledate", "reportdate", "date", "paydate")); if (!date) return null;
  const currency = (get("currencyprimary", "currency") || "GBP").trim().toUpperCase();
  const fxToBase = _ibnum(get("fxratetobase", "fxrate"));
  const symbol = (get("symbol", "underlyingsymbol") || "").trim().toUpperCase();
  const isin = (get("isin", "securityid") || "").trim().toUpperCase();
  let gbp = null, fxRate = null, needsFx = false;
  if (currency === "GBP") { gbp = amount; fxRate = 1; }
  else if (baseCurrency === "GBP" && fxToBase) { gbp = amount * fxToBase; fxRate = fxToBase; }
  else needsFx = true;
  return { date, ticker: symbol, isin, kind, nativeCurrency: currency, nativeAmount: amount, fxRate, amount: gbp == null ? null : Math.round(gbp * 100) / 100, needsFx, wrapper: defaultWrapper };
}
function _ibFlex(rows, defaultWrapper, baseCurrency, warnings) {
  const header = rows[0].map(_ibnorm); const headerIndex = {}; header.forEach((h, i) => { if (!(h in headerIndex)) headerIndex[h] = i; });
  const pick = _ibpick(headerIndex); const has = (...k) => k.some((x) => headerIndex[x] != null);
  const looksTrades = has("tradedate", "buysell", "tradeprice") || (has("quantity") && has("proceeds"));
  const looksCash = has("type", "amount") && !has("tradeprice", "buysell");
  const trades = [], income = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]; const get = (...k) => pick(row, ...k);
    if (looksCash && !looksTrades) { const c = _ibCash(get, defaultWrapper, baseCurrency); if (c) income.push(c); continue; }
    const t = _ibTrade(get, defaultWrapper, baseCurrency, warnings); if (t) { trades.push(t); continue; }
    if (has("type", "amount")) { const c = _ibCash(get, defaultWrapper, baseCurrency); if (c) income.push(c); }
  }
  return { trades, income };
}
function _ibActivity(rows, defaultWrapper, baseCurrency, warnings) {
  const trades = [], income = []; const sections = {};
  for (const row of rows) { const name = row[0], tag = row[1];
    if (tag === "Header") sections[name] = { header: row.slice(2).map(_ibnorm), data: [] };
    else if (tag === "Data" && sections[name]) sections[name].data.push(row.slice(2)); }
  const build = (sec) => { const idx = {}; sec.header.forEach((h, i) => { if (!(h in idx)) idx[h] = i; }); return { idx, pick: _ibpick(idx) }; };
  if (sections["Trades"]) { const { pick } = build(sections["Trades"]);
    for (const row of sections["Trades"].data) { const get = (...k) => pick(row, ...k);
      const disc = _ibnorm(get("datadiscriminator") || "order"); if (disc && !["order", "trade"].includes(disc)) continue;
      const t = _ibTrade(get, defaultWrapper, baseCurrency, warnings); if (t) trades.push(t); } }
  for (const secName of ["Dividends", "Payment In Lieu Of Dividends", "Interest"]) {
    if (!sections[secName]) continue; const { pick } = build(sections[secName]);
    for (const row of sections[secName].data) { const get = (...k) => pick(row, ...k);
      const desc = get("description") || ""; const isinM = String(desc).match(/\(([A-Z]{2}[A-Z0-9]{9}\d)\)/); const symM = String(desc).match(/^([A-Z0-9.]+)\b/);
      const kind = secName === "Interest" ? "interest" : "dividend"; const amount = _ibnum(get("amount")); if (amount <= 0) continue;
      const date = _ibdate(get("date", "settledate", "reportdate")); if (!date) continue;
      const currency = (get("currency", "currencyprimary") || "GBP").trim().toUpperCase();
      let gbp = null, needsFx = false; if (currency === "GBP") gbp = amount; else needsFx = true;
      income.push({ date, ticker: symM ? symM[1].toUpperCase() : "", isin: isinM ? isinM[1] : "", kind, nativeCurrency: currency, nativeAmount: amount, fxRate: currency === "GBP" ? 1 : null, amount: gbp == null ? null : Math.round(gbp * 100) / 100, needsFx, wrapper: defaultWrapper }); } }
  return { trades, income };
}
export function parseIBKR(text, { defaultWrapper = "GIA", baseCurrency = "GBP" } = {}) {
  const rows = parseCSVRows(text); if (!rows.length) return { trades: [], income: [], warnings: ["Empty file."], baseCurrency };
  const warnings = [];
  const sectioned = rows.some((r) => r[1] === "Header" && ["Trades", "Dividends", "Interest", "Deposits & Withdrawals", "Payment In Lieu Of Dividends"].includes(r[0]));
  const { trades, income } = sectioned ? _ibActivity(rows, defaultWrapper, baseCurrency, warnings) : _ibFlex(rows, defaultWrapper, baseCurrency, warnings);
  const needFx = trades.filter((t) => t.needsFx).length + income.filter((t) => t.needsFx).length;
  if (needFx) warnings.push(`${needFx} row(s) in a non-GBP currency need an FX rate; fetching by trade date.`);
  return { trades, income, warnings, baseCurrency, format: sectioned ? "activity" : "flex" };
}
