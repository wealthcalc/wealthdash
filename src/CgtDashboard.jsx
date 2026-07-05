import React, { useState, useMemo, useCallback, useRef } from "react";
import Papa from "papaparse";
import {
  Plus, Trash2, Download, Upload, Wand2, RefreshCw, Moon, Sun,
  TableProperties, Receipt, FlaskConical, FileUp, AlertTriangle, Check,
  Wallet, TrendingUp, TrendingDown, FileText, Printer, AlertCircle, PoundSterling, PieChart, Percent, Landmark, Info, PiggyBank,
} from "lucide-react";
// The CGT matching engine now lives in a standalone, node-tested module so the
// CGT view and the wealth core share one source of truth (see core/cgt-engine.mjs).
import { matchPortfolio, ukTaxYear } from "./core/cgt-engine.mjs";
// Wealth core (build step 1): wrapper-aware unified holdings model. Pure and
// node-tested (portfolio.test.mjs); the Wealth tab is a thin view over it.
import { buildWealthModel, classifyInstrument, WRAPPERS, normWrapper, isWrapperTaxable } from "./core/portfolio.mjs";
// Returns engine (build step 3): XIRR, per-holding TWR, snapshot-based
// portfolio TWR, income yields. Node-tested (returns.test.mjs).
import { computeReturns, xirr } from "./core/returns.mjs";
// Gilt engine (build step 4): coupon schedule, accrued interest, clean/dirty,
// GRY, Accrued Income Scheme. DMO/HMRC-verified conventions (gilts.test.mjs).
import { giltAnalytics } from "./core/gilts.mjs";
import { guessPensionColumns, mapPensionRow } from "./core/pension-import.mjs";
// xlsx (SheetJS) is ~120kb gzipped and only needed for the iShares ERI
// importer, so it's loaded on demand (see readWorkbookFile) rather than
// bundled into the initial page load.

// Safe localStorage wrapper: persists on the deployed app, silently no-ops in
// sandboxed preview frames where storage access throws.
const store = {
  get(k, fallback) { try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sandbox */ } },
};

// Historical UK tax-year parameters for SHARES / non-property assets.
// aea = annual exempt amount; basicLimit = income-tax basic-rate limit (band above the
// personal allowance); pa = personal allowance; reportThreshold = proceeds figure above
// which a disposal must be reported (4xAEA before 2023/24, fixed £50k after). 2024/25
// splits at the 30 Oct 2024 Budget (10/20 -> 18/24). Verified against GOV.UK / HoC Library.
const _Y = (aea, basicLimit, pa, reportThreshold, rates) => ({ aea, basicLimit, pa, reportThreshold, rates });
const _ONE = (basic, higher) => [{ from: "0000-00-00", basic, higher }];
const TAX_YEARS = {
  "2015/16": _Y(11100, 31785, 10600, 44400, _ONE(0.18, 0.28)),
  "2016/17": _Y(11100, 32000, 11000, 44400, _ONE(0.10, 0.20)),
  "2017/18": _Y(11300, 33500, 11500, 45200, _ONE(0.10, 0.20)),
  "2018/19": _Y(11700, 34500, 11850, 46800, _ONE(0.10, 0.20)),
  "2019/20": _Y(12000, 37500, 12500, 48000, _ONE(0.10, 0.20)),
  "2020/21": _Y(12300, 37500, 12500, 49200, _ONE(0.10, 0.20)),
  "2021/22": _Y(12300, 37700, 12570, 49200, _ONE(0.10, 0.20)),
  "2022/23": _Y(12300, 37700, 12570, 49200, _ONE(0.10, 0.20)),
  "2023/24": _Y(6000, 37700, 12570, 50000, _ONE(0.10, 0.20)),
  "2024/25": _Y(3000, 37700, 12570, 50000, [
    { from: "0000-00-00", basic: 0.10, higher: 0.20 },
    { from: "2024-10-30", basic: 0.18, higher: 0.24 },
  ]),
  "2025/26": _Y(3000, 37700, 12570, 50000, _ONE(0.18, 0.24)),
  "2026/27": _Y(3000, 37700, 12570, 50000, _ONE(0.18, 0.24)),
};
const LATEST_YEAR = "2026/27";
const cfgFor = (year) => TAX_YEARS[year] || { ...TAX_YEARS[LATEST_YEAR], assumed: true };
const aeaForYear = (year) => cfgFor(year).aea;
const rateForDate = (cfg, dateStr) => { let p = cfg.rates[0]; for (const r of cfg.rates) if (r.from <= dateStr) p = r; return p; };
// Personal allowance tapers by £1 for every £2 of income over £100,000.
const paFor = (pa, income) => (income <= 100000 ? pa : Math.max(0, pa - (income - 100000) / 2));

function liabilityForYear(disposals, { income = 0, carriedLosses = 0 } = {}) {
  const zero = { gains: 0, losses: 0, usedCarried: 0, aea: 0, taxable: 0, atBasic: 0, atHigher: 0, tax: 0, proceeds: 0, net: 0, reporting: false, breakdown: [], assumed: false, personalAllowance: 0, taxableIncome: 0 };
  if (!disposals.length) return zero;
  const cfg = cfgFor(disposals[0].taxYear);
  const entries = []; let losses = 0, proceeds = 0;
  for (const d of disposals) {
    proceeds += d.proceeds;
    if (d.gain > 0) { const r = rateForDate(cfg, d.date); entries.push({ amount: d.gain, basic: r.basic, higher: r.higher }); }
    else losses += -d.gain;
  }
  const gains = entries.reduce((s, e) => s + e.amount, 0);
  const net = gains - losses;
  let usedCarried = 0;
  if (net > cfg.aea && carriedLosses > 0) usedCarried = Math.min(net - cfg.aea, carriedLosses);
  // losses + carried losses + AEA reduce the highest-rate gains first (taxpayer-favourable).
  entries.sort((a, b) => b.higher - a.higher || b.basic - a.basic);
  let reductions = losses + usedCarried + cfg.aea;
  for (const e of entries) { const cut = Math.min(e.amount, reductions); e.amount -= cut; reductions -= cut; if (reductions <= 0) break; }
  // Income consumes the basic-rate band only after the personal allowance. Unused PA
  // cannot shelter gains; gains are the top slice above taxable income.
  const personalAllowance = paFor(cfg.pa, income);
  const taxableIncome = Math.max(0, income - personalAllowance);
  let bandLeft = Math.max(0, cfg.basicLimit - taxableIncome);
  const taxableEntries = entries.filter((e) => e.amount > 0).sort((a, b) => (b.higher - b.basic) - (a.higher - a.basic));
  let tax = 0, atBasic = 0, atHigher = 0; const byRate = {};
  for (const e of taxableEntries) {
    const b = Math.min(e.amount, bandLeft), h = e.amount - b;
    atBasic += b; atHigher += h; bandLeft -= b; tax += b * e.basic + h * e.higher;
    if (b > 0) byRate[e.basic] = (byRate[e.basic] || 0) + b;
    if (h > 0) byRate[e.higher] = (byRate[e.higher] || 0) + h;
  }
  const breakdown = Object.entries(byRate).map(([rate, amount]) => ({ rate: +rate, amount, tax: amount * +rate })).sort((a, b) => a.rate - b.rate);
  return { gains, losses, usedCarried, aea: cfg.aea, taxable: atBasic + atHigher, atBasic, atHigher, tax, proceeds, net, reporting: tax > 0 || proceeds > cfg.reportThreshold, breakdown, assumed: !!cfg.assumed, personalAllowance, taxableIncome };
}
const sharesForTargetGain = (q, c, p, target) => {
  const per = p - c / q; if (per <= 0) return q; return Math.min(q, Math.floor(target / per));
};
const fmtRate = (r) => `${(r * 100).toFixed(0)}%`;

// Chain per-year CGT liability across tax years, carrying losses forward.
// In-year losses offset in-year gains fully; brought-forward losses reduce net
// gains only down to the AEA; unused losses carry forward (4-year claim window).
function liabilityAllYears(disposals, { incomeByYear = {}, initialCarried = 0 } = {}) {
  const byYear = {}; for (const d of disposals) (byYear[d.taxYear] ||= []).push(d);
  const years = Object.keys(byYear).sort();
  let carried = initialCarried; const results = {};
  for (const y of years) {
    const res = liabilityForYear(byYear[y], { income: incomeByYear[y] || 0, carriedLosses: carried });
    const carriedInto = carried, inYearNetLoss = Math.max(0, res.losses - res.gains);
    carried = carried - res.usedCarried + inYearNetLoss;
    results[y] = { ...res, carriedInto, carriedOut: carried, inYearNetLoss };
  }
  return { years, results, carriedForward: carried };
}
const unitsHeldAt = (txns, dateStr, ticker) => {
  const want = ticker ? String(ticker).toUpperCase() : null;
  let q = 0; for (const t of txns) { if (t.side !== "BUY" && t.side !== "SELL") continue; if (want && String(t.ticker || "").toUpperCase() !== want) continue; if (t.date <= dateStr) q += (t.side === "BUY" ? 1 : -1) * t.quantity; } return q;
};

/* ---- UK income tax on investment income (dividends + interest), stacked on
   salary. Nil-rate allowances (PSA, dividend allowance) sit at 0% but occupy band
   space. Verified in incometax.test.mjs (11/11). ---- */
const _I = (pa, basicLimit, addl, divAllow, div, sav, psa) => ({ pa, basicLimit, addl, divAllow, div, sav, psa });
const _DO = { basic: 0.075, higher: 0.325, addl: 0.381 }, _DM = { basic: 0.0875, higher: 0.3375, addl: 0.3935 }, _DN = { basic: 0.1075, higher: 0.3575, addl: 0.3935 };
const _SAV = { basic: 0.20, higher: 0.40, addl: 0.45 }, _PSA = { basic: 1000, higher: 500, addl: 0 };
const INCOME_YEARS = {
  "2016/17": _I(11000, 32000, 150000, 5000, _DO, _SAV, _PSA), "2017/18": _I(11500, 33500, 150000, 5000, _DO, _SAV, _PSA),
  "2018/19": _I(11850, 34500, 150000, 2000, _DO, _SAV, _PSA), "2019/20": _I(12500, 37500, 150000, 2000, _DO, _SAV, _PSA),
  "2020/21": _I(12500, 37500, 150000, 2000, _DO, _SAV, _PSA), "2021/22": _I(12570, 37700, 150000, 2000, _DO, _SAV, _PSA),
  "2022/23": _I(12570, 37700, 150000, 2000, _DM, _SAV, _PSA), "2023/24": _I(12570, 37700, 125140, 1000, _DM, _SAV, _PSA),
  "2024/25": _I(12570, 37700, 125140, 500, _DM, _SAV, _PSA), "2025/26": _I(12570, 37700, 125140, 500, _DM, _SAV, _PSA),
  "2026/27": _I(12570, 37700, 125140, 500, _DN, _SAV, _PSA),
};
const incomeCfg = (year) => INCOME_YEARS[year] || { ...INCOME_YEARS["2026/27"], assumed: true };
function _walk(pos, amount, basicTop, higherTop, rates) {
  const bounds = [basicTop, higherTop, Infinity], rs = [rates.basic, rates.higher, rates.addl];
  let tax = 0, p = pos, rem = amount;
  for (let i = 0; i < 3 && rem > 1e-9; i++) { if (p >= bounds[i]) continue; const take = Math.min(rem, bounds[i] - p); tax += take * rs[i]; p += take; rem -= take; }
  return { tax, end: p };
}
function investmentIncomeTax({ salary = 0, interest = 0, dividends = 0, year } = {}) {
  const c = incomeCfg(year), ani = salary + interest + dividends;
  const pa = paFor(c.pa, ani), basicTop = c.basicLimit, higherTop = Math.max(basicTop, c.addl - pa);
  let paLeft = pa; const net = (x) => { const u = Math.min(x, paLeft); paLeft -= u; return x - u; };
  const salT = net(salary), intT = net(interest), divT = net(dividends), taxableTotal = salT + intT + divT;
  const band = taxableTotal <= basicTop ? "basic" : taxableTotal <= higherTop ? "higher" : "addl";
  const psa = c.psa[band], startRate = Math.max(0, 5000 - salT);
  let pos = salT, interestTax = 0, dividendTax = 0;
  { let rem = intT; const z = Math.min(rem, startRate + psa); pos += z; rem -= z; const r = _walk(pos, rem, basicTop, higherTop, c.sav); interestTax = r.tax; pos = r.end; }
  { let rem = divT; const z = Math.min(rem, c.divAllow); pos += z; rem -= z; const r = _walk(pos, rem, basicTop, higherTop, c.div); dividendTax = r.tax; pos = r.end; }
  const r2 = (x) => Math.round(x * 100) / 100;
  return { year, assumed: !!c.assumed, interestTax: r2(interestTax), dividendTax: r2(dividendTax), tax: r2(interestTax + dividendTax), personalAllowance: pa, band, divAllow: c.divAllow, psa };
}

/* ---- IBKR CSV import (Flex Query + Activity Statement) -> trades + income.
   Verified in ibkr.test.mjs (20/20). ---- */
function parseCSVRows(text) {
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
function parseIBKR(text, { defaultWrapper = "GIA", baseCurrency = "GBP" } = {}) {
  const rows = parseCSVRows(text); if (!rows.length) return { trades: [], income: [], warnings: ["Empty file."], baseCurrency };
  const warnings = [];
  const sectioned = rows.some((r) => r[1] === "Header" && ["Trades", "Dividends", "Interest", "Deposits & Withdrawals", "Payment In Lieu Of Dividends"].includes(r[0]));
  const { trades, income } = sectioned ? _ibActivity(rows, defaultWrapper, baseCurrency, warnings) : _ibFlex(rows, defaultWrapper, baseCurrency, warnings);
  const needFx = trades.filter((t) => t.needsFx).length + income.filter((t) => t.needsFx).length;
  if (needFx) warnings.push(`${needFx} row(s) in a non-GBP currency need an FX rate; fetching by trade date.`);
  return { trades, income, warnings, baseCurrency, format: sectioned ? "activity" : "flex" };
}

/* ---- Multi-year AEA disposal / gain-harvesting optimiser. Verified in
   optimiser.test.mjs (14/14). ---- */
const nextTaxYear = (y) => { const a = Number(y.split("/")[0]) + 1; return `${a}/${String(a + 1).slice(-2)}`; };
function optimiseDisposals({ holdings, startYear, years = 10, income = 0, useBasicBand = false, growth = 0 }) {
  let hs = holdings.map((h) => ({ ticker: h.ticker, qty: +h.qty, avgCost: +h.qty ? +h.cost / +h.qty : 0, price: +h.price })).filter((h) => h.qty > 0 && isFinite(h.price) && h.price > 0);
  const embedded = () => hs.reduce((s, h) => s + Math.max(0, h.qty * (h.price - h.avgCost)), 0);
  const startEmbedded = embedded(); const schedule = []; let y = startYear, totalWashed = 0, yearsToClear = null;
  for (let i = 0; i < years; i++) {
    const cfg = cfgFor(y); const pa = paFor(cfg.pa, income); const taxableIncome = Math.max(0, income - pa);
    const bandRoom = Math.max(0, cfg.basicLimit - taxableIncome); const rate = cfg.rates[cfg.rates.length - 1];
    const gainBudget = cfg.aea + (useBasicBand ? bandRoom : 0);
    let budgetLeft = gainBudget, realised = 0; const sells = [];
    const order = hs.map((h, idx) => ({ idx, gps: h.price - h.avgCost })).filter((o) => o.gps > 0).sort((a, b) => b.gps - a.gps);
    for (const { idx } of order) {
      if (budgetLeft <= 1e-6) break; const h = hs[idx], gps = h.price - h.avgCost;
      const takeGain = Math.min(h.qty * gps, budgetLeft); const shares = takeGain / gps;
      h.avgCost = ((h.qty - shares) * h.avgCost + shares * h.price) / h.qty;
      realised += takeGain; budgetLeft -= takeGain;
      sells.push({ ticker: h.ticker, shares: Math.round(shares * 1e4) / 1e4, gain: Math.round(takeGain * 100) / 100 });
    }
    const aeaUsed = Math.min(realised, cfg.aea); const bandGain = Math.max(0, realised - cfg.aea);
    const tax = Math.round((useBasicBand ? bandGain * rate.basic : 0) * 100) / 100; totalWashed += realised;
    const remaining = embedded();
    schedule.push({ year: y, aea: cfg.aea, gainBudget, gainRealised: Math.round(realised * 100) / 100, aeaUsed: Math.round(aeaUsed * 100) / 100, bandGain: Math.round(bandGain * 100) / 100, tax, sells, cumulativeWashed: Math.round(totalWashed * 100) / 100, remainingUnrealised: Math.round(remaining * 100) / 100 });
    if (remaining <= 1e-6 && yearsToClear == null) yearsToClear = i + 1;
    if (remaining <= 1e-6) break;
    if (growth) for (const h of hs) h.price *= 1 + growth; y = nextTaxYear(y);
  }
  return { schedule, yearsToClear, totalWashed: Math.round(totalWashed * 100) / 100, startEmbedded: Math.round(startEmbedded * 100) / 100, remainingAfter: Math.round(embedded() * 100) / 100 };
}

// Seed ISIN/domicile data for holdings, sourced from issuer fact sheets. Only
// covers tickers actually held (per the 2026-07 GIA ledger import); anything
// else is left blank for the user to fill in. `eri` flags offshore reporting
// funds (Irish/Lux-domiciled accumulating ETFs) that generate excess reportable
// income when held unsheltered; UK investment trusts are ordinary companies and
// pay ordinary dividends, not ERI, even though they accumulate/reinvest.
const SECURITY_SEED = {
  SJPA: { isin: "IE00B4L5YX21", name: "iShares Core MSCI Japan IMI UCITS ETF (Acc)", domicile: "IE", eri: true },
  CSP1: { isin: "IE00B5BMR087", name: "iShares Core S&P 500 UCITS ETF (Acc)", domicile: "IE", eri: true },
  EMIM: { isin: "IE00BKM4GZ66", name: "iShares Core MSCI EM IMI UCITS ETF (Acc)", domicile: "IE", eri: true },
  XNAQ: { isin: "IE00BMFKG444", name: "Xtrackers Nasdaq 100 UCITS ETF 1C", domicile: "IE", eri: true },
  UIFS: { isin: "IE00B4JNQZ49", name: "iShares S&P 500 Financials Sector UCITS ETF (Acc)", domicile: "IE", eri: true },
  HSTC: { isin: "IE00BMWXKN31", name: "HSBC Hang Seng TECH UCITS ETF", domicile: "IE", eri: true },
  IITU: { isin: "IE00B3WJKG14", name: "iShares S&P 500 Information Technology Sector UCITS ETF (Acc)", domicile: "IE", eri: true },
  SPXL: { isin: "IE000XZSV718", name: "SPDR S&P 500 UCITS ETF (Acc)", domicile: "IE", eri: true },
  SMT: { isin: "GB00BLDYK618", name: "Scottish Mortgage Investment Trust plc", domicile: "GB", eri: false, kind: "investment_trust" },
  ATT: { isin: "GB00BNG2M159", name: "Allianz Technology Trust plc", domicile: "GB", eri: false, kind: "investment_trust" },
  BNKR: { isin: "GB00BN4NDR39", name: "Bankers Investment Trust plc", domicile: "GB", eri: false, kind: "investment_trust" },
  AIAG: { isin: "IE00BK5BCD43", name: "iShares AI & Automation Growth UCITS ETF", domicile: "IE", eri: true },
  CYSE: { isin: "IE00BLPK3577", name: "iShares Cybersecurity UCITS ETF", domicile: "IE", eri: true },
  DFEU: { isin: "IE000IAXNM41", name: "Defense Europe UCITS ETF", domicile: "IE", eri: true },
  RBTX: { isin: "IE00BYZK4552", name: "iShares Robotics & Automation UCITS ETF", domicile: "IE", eri: true },
  RENG: { isin: "IE00BK5BCH80", name: "iShares Renewable Energy UCITS ETF", domicile: "IE", eri: true },
  // Closed positions (fully disposed) — kept for ERI matching on the years they
  // were actually held; a closed position can still owe ERI for any accounting
  // period that fell inside its holding window.
  SWDA: { isin: "IE00B4L5Y983", name: "iShares Core MSCI World UCITS ETF (Acc)", domicile: "IE", eri: true },
  CNX1: { isin: "IE00B53SZB19", name: "iShares NASDAQ 100 UCITS ETF (Acc)", domicile: "IE", eri: true },
  DGIT: { isin: "IE00BYZK4883", name: "iShares Digitalisation UCITS ETF (Acc)", domicile: "IE", eri: true },
  USDV: { isin: "IE00B6YX5D40", name: "SPDR S&P US Dividend Aristocrats UCITS ETF (Dist)", domicile: "IE", eri: true },
  SAIC: { isin: "GB0007873697", name: "Scottish American Investment Company plc", domicile: "GB", eri: false, kind: "investment_trust" },
  // Individual gilts (kind: "gilt" -> CGT-exempt via TCGA 1992 s115; coupons
  // taxable as interest in taxable wrappers). coupon = annual %, semi-annual
  // payments on the cycle anchored at maturity. Identifiers verified 2026-07
  // against multiple sources (LSE/TradingView/broker listings). Register any
  // other gilt from the Gilts tab.
  TN28: { isin: "GB00BMBL1G81", name: "0⅛% Treasury Gilt 2028", domicile: "GB", eri: false, kind: "gilt", coupon: 0.125, maturity: "2028-01-31" },
  TG31: { isin: "GB00BMGR2809", name: "0¼% Treasury Gilt 2031", domicile: "GB", eri: false, kind: "gilt", coupon: 0.25, maturity: "2031-07-31" },
  T26A: { isin: "GB00BNNGP668", name: "0⅜% Treasury Gilt 2026", domicile: "GB", eri: false, kind: "gilt", coupon: 0.375, maturity: "2026-10-22" },
};

/* ---- iShares/BlackRock "UK Reportable Income" workbook parser (one per fund
   umbrella — iShares Plc, iShares II-VII plc — one row per share class per
   accounting period, keyed by ISIN). Verified against 8 real files spanning
   2021-2025 across five umbrellas (see ishares.test.mjs, 29/29). Confirmed
   structure: Fund Umbrella Name | Fund Name | [Share Class Name] | ISIN |
   [HMRC share class reference] | Reporting Period | Currency | Statement
   Under Regulation 92(1)(e) | Excess of Reported Income per Unit | Fund
   Distribution Date | Meets definition of a Bond Fund for the period |
   Actual Distribution per Unit/Date - 1, 2, 3... (repeating, unused here).
   "Reporting Period" is a text range ("01 July 2024 to 30 June 2025" /
   "01.12.2024 to 30.11.2025" / "01/03/2020 to 28/02/2021" depending on
   report year) — period end is the second date. "Meets definition of a Bond
   Fund" is the authoritative dividend-vs-interest signal per HMRC's
   offshore-fund ERI treatment rule. Column detection stays keyword-based
   (not fixed-position) since column order shifts between umbrellas and
   report years. ---- */
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
function findHeaderRow(aoa, maxScan = 15) {
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
function guessColumnMap(headerRow) {
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
function extractISharesRows(aoa, headerRowIdx, colMap, holdingIsins) {
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
function parseISharesWorkbook(sheets, holdingIsins) {
  return sheets.map((s) => {
    const headerRowIdx = findHeaderRow(s.aoa);
    if (headerRowIdx < 0) return { name: s.name, headerRowIdx: -1, colMap: null, headerCells: [], rows: [] };
    const headerCells = s.aoa[headerRowIdx] || [];
    const colMap = guessColumnMap(headerCells);
    const rows = colMap.eriPerUnit >= 0 || colMap.isin >= 0 ? extractISharesRows(s.aoa, headerRowIdx, colMap, holdingIsins) : [];
    return { name: s.name, headerRowIdx, colMap, headerCells, rows };
  });
}

/* ----------------------------- helpers ------------------------------ */
const gbp = (x) => (x < 0 ? "−£" : "£") + Math.abs(x).toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// One chip style per wrapper, used everywhere a wrapper tag is shown, so
// adding a wrapper (like VCT) means updating one place, not three.
const WRAPPER_CHIP_CLASS = {
  GIA: "bg-[var(--chip)] text-[var(--fg)]",
  ISA: "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]",
  SIPP: "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]",
  LISA: "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]",
  VCT: "bg-[color:color-mix(in_srgb,var(--m-same)_18%,transparent)] text-[var(--m-same)]",
};
const wrapperChipClass = (w) => WRAPPER_CHIP_CLASS[w] || "bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)]";
const WrapperChip = ({ wrapper }) => <span className={"text-[10px] font-semibold px-1.5 py-0.5 rounded " + wrapperChipClass(wrapper)}>{wrapper}</span>;

// Shared sub-tab bar, used inside the CGT and Income mega-tabs so related
// tools live under one top-level tab instead of cluttering the main nav.
function SubTabs({ tabs, active, onChange }) {
  return (
    <div className="flex flex-wrap gap-1 border-b border-[var(--border)] mb-4">
      {tabs.map(([k, label]) => (
        <button key={k} onClick={() => onChange(k)}
          className={"px-3 py-1.5 text-sm font-medium border-b-2 -mb-px transition " +
            (active === k ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]")}>
          {label}
        </button>
      ))}
    </div>
  );
}

// Shared DMO gilt-price fetch, used by both the Gilts tab and the Wealth tab's
// live-prices panel (individual gilts aren't on Yahoo/Alpha Vantage, so they
// need the DMO proxy). Given [{ticker, isin}] targets, fetches clean prices and
// returns { pricesByTicker: {tk: clean/100}, matched, date }. Clean price is
// per £100 nominal; the app stores price per £1 nominal, hence /100.
async function fetchDmoGiltPrices(targets) {
  const withIsin = targets.filter((t) => t.isin);
  if (!withIsin.length) return { pricesByTicker: {}, matched: 0, date: null, error: "No gilt has an ISIN to look up." };
  const isins = withIsin.map((t) => t.isin).join(",");
  const r = await fetch(`/api/gilt-prices?isins=${encodeURIComponent(isins)}`);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  const pricesByTicker = {};
  let matched = 0;
  for (const t of withIsin) {
    const hit = body.prices[t.isin];
    if (hit) { pricesByTicker[t.ticker] = hit.clean / 100; matched++; }
  }
  return { pricesByTicker, matched, date: body.date, total: withIsin.length };
}
const num = (x, dp = 2) => (x ?? 0).toLocaleString("en-GB", { minimumFractionDigits: dp, maximumFractionDigits: dp });
const round2 = (x) => Math.round((+x || 0) * 100) / 100;

// £-prefixed input with thousands separators while not focused, plain
// editable number while focused (so typing isn't fighting live formatting).
// Used for cash balances, where "£73,137.00" is much easier to read at a
// glance than a bare "73137".
function CurrencyInput({ value, onChange, className = "" }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState(String(value ?? 0));
  React.useEffect(() => { if (!editing) setRaw(String(value ?? 0)); }, [value, editing]);
  return (
    <div className={"relative " + className}>
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--muted)] text-sm">£</span>
      <input
        type={editing ? "number" : "text"}
        className="input num w-full pl-5 text-right"
        value={editing ? raw : num(+value || 0, 2)}
        onFocus={() => { setEditing(true); setRaw(String(value ?? 0)); }}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={() => { setEditing(false); onChange(+raw || 0); }}
      />
    </div>
  );
}
const uid = () => Math.random().toString(36).slice(2, 9);
const todayISO = () => new Date().toISOString().slice(0, 10);

const SAMPLE = [
  { id: uid(), date: "2022-11-15", ticker: "WFC", side: "BUY", quantity: 120, nativeCurrency: "USD", nativeAmount: 5036, fxRate: 0.83, gbpAmount: 4180, note: "RSU vest" },
  { id: uid(), date: "2023-11-15", ticker: "WFC", side: "BUY", quantity: 140, nativeCurrency: "USD", nativeAmount: 6650, fxRate: 0.80, gbpAmount: 5320, note: "RSU vest" },
  { id: uid(), date: "2024-11-15", ticker: "WFC", side: "BUY", quantity: 160, nativeCurrency: "USD", nativeAmount: 11544, fxRate: 0.79, gbpAmount: 9120, note: "RSU vest" },
  { id: uid(), date: "2025-06-02", ticker: "WFC", side: "SELL", quantity: 200, nativeCurrency: "USD", nativeAmount: 18718, fxRate: 0.78, gbpAmount: 14600, note: "part sale" },
  { id: uid(), date: "2015-08-03", ticker: "AAPL", side: "BUY", quantity: 100, nativeCurrency: "USD", nativeAmount: 11500, fxRate: 0.64, gbpAmount: 7360, note: "" },
  { id: uid(), date: "2022-09-01", ticker: "AAPL", side: "SELL", quantity: 20, nativeCurrency: "USD", nativeAmount: 3200, fxRate: 0.86, gbpAmount: 2752, note: "" },
  { id: uid(), date: "2024-09-15", ticker: "AAPL", side: "SELL", quantity: 25, nativeCurrency: "USD", nativeAmount: 5500, fxRate: 0.76, gbpAmount: 4180, note: "pre-Budget" },
  { id: uid(), date: "2025-09-10", ticker: "AAPL", side: "SELL", quantity: 30, nativeCurrency: "USD", nativeAmount: 6900, fxRate: 0.74, gbpAmount: 5106, note: "" },
];

const METHOD = {
  SAME_DAY: { label: "Same-day", v: "--m-same" },
  THIRTY_DAY: { label: "30-day", v: "--m-bb" },
  SECTION_104: { label: "S104 pool", v: "--m-pool" },
};

/* ---- Alpha Vantage live prices (client-side; free tier: 25/day, 5/min) ----
   GLOBAL_QUOTE returns a price but NO currency, so the currency is set per
   ticker and every quote is normalised to GBP (GBp pence ÷100; USD/EUR via FX). */
const AV_URL = "https://www.alphavantage.co/query";
async function avQuote(symbol, key) {
  const res = await fetch(`${AV_URL}?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(key)}`);
  const j = await res.json();
  if (j.Note || j.Information) throw new Error("Alpha Vantage limit hit (25/day, 5/min) — try again later.");
  const q = j["Global Quote"];
  const p = q && q["05. price"];
  if (p == null || p === "") throw new Error(`No quote for "${symbol}" (LSE symbols need .LON).`);
  return parseFloat(p);
}
/* ---- FX rate resolution: three-tier fallback.
   1. Frankfurter (frankfurter.dev) — primary, free, no key, no shared budget.
   2. Yahoo Finance, via the /api/fx serverless proxy — same infra as live
      prices, covers gaps when Frankfurter lacks a date/pair or is down.
   3. Alpha Vantage FX_DAILY — last resort, since it shares the same 25/day
      budget as equity price lookups (see avBudget/avBump below).
   All three return the same thing: GBP per 1 unit of the given currency. ---- */
async function fxViaFrankfurter(ccy, date) {
  try { const r = await fetch(`https://api.frankfurter.dev/v1/${date}?from=${ccy}&to=GBP`); const j = await r.json(); return j?.rates?.GBP ?? null; }
  catch { return null; }
}
async function fxViaYahoo(ccy, date) {
  try { const r = await fetch(`/api/fx?ccy=${encodeURIComponent(ccy)}&date=${encodeURIComponent(date)}`); if (!r.ok) return null; const j = await r.json(); return j?.rate ?? null; }
  catch { return null; }
}
async function fxViaAlphaVantage(ccy, date, key) {
  if (!key) return null;
  try {
    const res = await fetch(`${AV_URL}?function=FX_DAILY&from_symbol=${encodeURIComponent(ccy)}&to_symbol=GBP&apikey=${encodeURIComponent(key)}`);
    const j = await res.json();
    if (j.Note || j.Information) return null; // rate limit or bad key — fail soft, let the caller try elsewhere
    const series = j["Time Series FX (Daily)"];
    if (!series) return null;
    const onOrBefore = Object.keys(series).filter((d) => d <= date).sort();
    const pick = onOrBefore.length ? onOrBefore[onOrBefore.length - 1] : Object.keys(series).sort()[0];
    const close = pick && series[pick] && series[pick]["4. close"];
    return close ? parseFloat(close) : null;
  } catch { return null; }
}
async function fxHistorical(ccy, date) {
  if (ccy === "GBP" || ccy === "GBp") return 1;
  let rate = await fxViaFrankfurter(ccy, date);
  if (rate) return rate;
  rate = await fxViaYahoo(ccy, date);
  if (rate) return rate;
  const key = store.get("cgt.avkey", "");
  if (key && avBudget().n < 25) {
    rate = await fxViaAlphaVantage(ccy, date, key);
    if (rate) { avBump(); return rate; }
  }
  return null;
}
async function fxToGBP(ccy) {
  if (ccy === "GBP" || ccy === "GBp") return 1;
  return fxHistorical(ccy, todayISO());
}
const toGBP = (raw, ccy, fx) => (ccy === "GBp" ? raw / 100 : ccy === "GBP" ? raw : fx ? raw * fx : null);
const avBudget = () => { const c = store.get("cgt.avcount", { date: "", n: 0 }); return c.date === todayISO() ? c : { date: todayISO(), n: 0 }; };
const avBump = () => { const c = avBudget(); c.n += 1; store.set("cgt.avcount", c); return c.n; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================== app =================================== */
export default function App() {
  const [dark, setDark] = useState(() => store.get("cgt.dark", true));
  const [txns, setTxns] = useState(() => store.get("cgt.txns", SAMPLE));
  const [tab, setTab] = useState(() => store.get("cgt.tab", "wealth"));
  const [income, setIncome] = useState(() => store.get("cgt.income", 200000));
  const [carried, setCarried] = useState(() => store.get("cgt.carried", 0));
  const [cash, setCash] = useState(() => store.get("cgt.cash", {})); // { wrapper: GBP balance }
  const [pensionCashflows, setPensionCashflows] = useState(() => store.get("cgt.pensioncf", [])); // [{id, date, provider, type, ccy, nativeAmount}]
  const [valuations, setValuations] = useState(() => store.get("cgt.valuations", [])); // [{date, value, byWrapper}]
  const [incomeEntries, setIncomeEntries] = useState(() => store.get("cgt.incomeEntries", [])); // dividends/interest ledger
  const [eriEntries, setEriEntries] = useState(() => store.get("cgt.eriEntries", []));           // excess reportable income
  const [prices, setPrices] = useState(() => store.get("cgt.prices", {}));
  const [avKey, setAvKey] = useState(() => store.get("cgt.avkey", ""));
  const [avMeta, setAvMeta] = useState(() => store.get("cgt.avmeta", {}));       // { ticker: {symbol, currency} }
  const [priceMeta, setPriceMeta] = useState(() => store.get("cgt.pricemeta", {})); // { ticker: {asOf, raw, ccy} }
  const [secMeta, setSecMeta] = useState(() => ({ ...SECURITY_SEED, ...store.get("cgt.secmeta", {}) })); // { ticker: {isin, name, domicile, eri} }
  const [error, setError] = useState(null);

  // persist (guarded; no-ops in sandbox)
  React.useEffect(() => store.set("cgt.txns", txns), [txns]);
  React.useEffect(() => store.set("cgt.prices", prices), [prices]);
  React.useEffect(() => store.set("cgt.avkey", avKey), [avKey]);
  React.useEffect(() => store.set("cgt.avmeta", avMeta), [avMeta]);
  React.useEffect(() => store.set("cgt.pricemeta", priceMeta), [priceMeta]);
  React.useEffect(() => store.set("cgt.secmeta", secMeta), [secMeta]);
  React.useEffect(() => store.set("cgt.income", income), [income]);
  React.useEffect(() => store.set("cgt.carried", carried), [carried]);
  React.useEffect(() => store.set("cgt.incomeEntries", incomeEntries), [incomeEntries]);
  React.useEffect(() => store.set("cgt.eriEntries", eriEntries), [eriEntries]);
  React.useEffect(() => store.set("cgt.dark", dark), [dark]);
  React.useEffect(() => store.set("cgt.cash", cash), [cash]);
  React.useEffect(() => store.set("cgt.pensioncf", pensionCashflows), [pensionCashflows]);
  React.useEffect(() => store.set("cgt.tab", tab), [tab]);
  React.useEffect(() => store.set("cgt.valuations", valuations), [valuations]);

  // Only unsheltered (GIA) holdings are within scope for CGT and income tax;
  // ISA / SIPP / LISA are tax-free and excluded from every tax computation.
  const isGIA = (w) => (w || "GIA") === "GIA";
  const giaTxns = useMemo(() => txns.filter((t) => isGIA(t.wrapper)), [txns]);

  // Excess reportable income -> synthetic ERI txns (pool cost uplift) + income.
  const eriTxns = useMemo(() => eriEntries.map((e) => {
    const units = unitsHeldAt(giaTxns, e.periodEnd || "9999-12-31", e.ticker);
    const native = units * (+e.perShare || 0);
    const g = e.currency === "GBp" ? native / 100 : e.currency === "GBP" ? native : native * (+e.fxRate || 0);
    return { id: "eri-" + e.id, ticker: e.ticker, side: "ERI", date: e.distributionDate, quantity: 0, gbpAmount: Math.round((g || 0) * 100) / 100, _eri: e, _units: units, _gbp: g || 0 };
  }).filter((t) => t.ticker && t.date), [eriEntries, giaTxns]);

  const matched = useMemo(() => {
    try { setError(null); return matchPortfolio([...giaTxns, ...eriTxns]); }
    catch (e) { setError(e.message); return { disposals: [], pools: {} }; }
  }, [giaTxns, eriTxns]);

  // The wealth model reads ALL wrappers — the whole point of the wealth core.
  // (eriTxns stay GIA-scoped: ERI only arises on unsheltered holdings.)
  const wealthModel = useMemo(() => {
    try { return buildWealthModel({ txns, eriTxns, incomeEntries, secMeta, prices, cash }); }
    catch { return null; } // a malformed ledger shows its error via `matched` above
  }, [txns, eriTxns, incomeEntries, secMeta, prices, cash]);

  // Record a securities-only valuation snapshot (one per day, last write wins)
  // whenever every open position is priced. This series is what makes an
  // EXACT portfolio-level TWR possible over time — no snapshots, no TWR,
  // rather than a stale-price approximation.
  React.useEffect(() => {
    if (!wealthModel || !wealthModel.positions.length || wealthModel.total.unpriced > 0) return;
    const value = +wealthModel.total.marketValue.toFixed(2);
    const date = todayISO();
    setValuations((v) => {
      const last = v.length && v[v.length - 1].date === date ? v[v.length - 1] : null;
      if (last && last.value === value) return v; // no change — bail to avoid re-render churn
      const rest = v.filter((s) => s.date !== date);
      const byWrapper = Object.fromEntries(Object.entries(wealthModel.byWrapper).map(([w, a]) => [w, +a.marketValue.toFixed(2)]));
      return [...rest, { date, value, byWrapper }].sort((a, b) => (a.date < b.date ? -1 : 1));
    });
  }, [wealthModel]);

  // Returns & income analytics (build step 3) — all wrappers, pre-tax.
  const returns = useMemo(() => {
    try { return computeReturns({ txns, incomeEntries, eriTxns, prices, valuations }); }
    catch { return null; }
  }, [txns, incomeEntries, eriTxns, prices, valuations]);

  // Gilt ladder analytics (build step 4) — driven by secMeta kind: "gilt".
  const giltData = useMemo(() => {
    try { return giltAnalytics({ txns, secMeta, prices }); }
    catch { return null; }
  }, [txns, secMeta, prices]);

  // Individual gilts are CGT-exempt (TCGA 1992 s115), but `matched` (the raw
  // matching engine output) doesn't know about instrument type — it'll happily
  // compute a "gain" on a gilt disposal exactly like any equity. Every view
  // that computes or reports CGT LIABILITY must exclude exempt instruments;
  // views that just show GIA holdings (the legacy Holdings tab) are unaffected
  // and keep showing gilts, since that's a holdings list, not a tax computation.
  const isCgtExempt = useMemo(() => {
    const cache = new Map();
    return (ticker) => {
      if (!cache.has(ticker)) cache.set(ticker, classifyInstrument(ticker, secMeta).cgtExempt);
      return cache.get(ticker);
    };
  }, [secMeta]);
  const taxableDisposals = useMemo(
    () => matched.disposals.filter((d) => !isCgtExempt(d.ticker)),
    [matched, isCgtExempt]
  );
  const taxablePools = useMemo(() => {
    const out = {};
    for (const [tk, p] of Object.entries(matched.pools)) if (!isCgtExempt(tk)) out[tk] = p;
    return out;
  }, [matched, isCgtExempt]);
  const exemptGiltDisposalCount = matched.disposals.length - taxableDisposals.length;

  const taxYears = useMemo(() => {
    const s = new Set(taxableDisposals.map((d) => d.taxYear));
    return [...s].sort().reverse();
  }, [taxableDisposals]);
  const [year, setYear] = useState(null);
  const activeYear = year && taxYears.includes(year) ? year : taxYears[0] || "2025/26";

  // Chain CGT losses across all tracked years (initial b/f losses = `carried`).
  const allYears = useMemo(() => {
    const yrs = [...new Set(taxableDisposals.map((d) => d.taxYear))];
    const inc = Object.fromEntries(yrs.map((y) => [y, income]));
    return liabilityAllYears(taxableDisposals, { incomeByYear: inc, initialCarried: carried });
  }, [taxableDisposals, income, carried]);

  const yearDisposals = taxableDisposals.filter((d) => d.taxYear === activeYear);
  const liab = allYears.results[activeYear] || liabilityForYear(yearDisposals, { income, carriedLosses: carried });

  // Aggregate dividends/interest per tax year (ledger + ERI-derived income).
  const incomeByYear = useMemo(() => {
    const m = {}; const add = (y, kind, amt) => { (m[y] ||= { dividends: 0, interest: 0 }); m[y][kind === "interest" ? "interest" : "dividends"] += amt; };
    for (const e of incomeEntries) if (e.date && e.amount && isGIA(e.wrapper)) add(ukTaxYear(e.date), e.kind, +e.amount);
    for (const t of eriTxns) if (t.date) add(ukTaxYear(t.date), t._eri.treatment, t._gbp);
    return m;
  }, [incomeEntries, eriTxns]);

  // All-wrapper income (taxable AND sheltered), grouped by year then wrapper —
  // so the Income tab can show the full picture, not just the CGT-relevant part.
  const incomeAllWrappers = useMemo(() => {
    const m = {};
    for (const e of incomeEntries) {
      if (!e.date || !e.amount) continue;
      const y = ukTaxYear(e.date), w = normWrapper(e.wrapper);
      (m[y] ||= {});
      (m[y][w] ||= { dividends: 0, interest: 0 });
      m[y][w][e.kind === "interest" ? "interest" : "dividends"] += +e.amount;
    }
    return m;
  }, [incomeEntries]);

  const fileRef = useRef(null);
  const [status, setStatus] = useState("");
  const flash = (msg) => { setStatus(msg); setTimeout(() => setStatus(""), 3500); };

  const exportJSON = async () => {
    const backup = {
      __cgtBackup: true, version: 4, exportedAt: new Date().toISOString(),
      txns, incomeEntries, eriEntries, income, carried, cash, valuations,
      prices, priceMeta, avKey, avMeta, secMeta, pensionCashflows,
    };
    const text = JSON.stringify(backup, null, 2);
    let downloaded = false;
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `cgt-backup-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloaded = true;
    } catch { /* sandbox may block downloads */ }
    // Clipboard fallback so export never silently fails inside a sandboxed frame.
    try { await navigator.clipboard.writeText(text); flash(downloaded ? "Downloaded — also copied to clipboard." : "Download blocked here; JSON copied to clipboard instead."); }
    catch { flash(downloaded ? "Downloaded." : "Couldn't download or copy in this frame — try the deployed app."); }
  };
  const importJSON = (e) => {
    const f = e.target.files?.[0]; if (!f) { return; }
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (Array.isArray(d)) {
          // Legacy export: a bare transaction array, nothing else.
          setTxns(d.map((x) => ({ ...x, id: x.id || uid() })));
          flash(`Imported ${d.length} transactions (legacy format — no income/ERI data in this file).`);
        } else if (d && d.__cgtBackup) {
          const n = (arr) => Array.isArray(arr) ? arr.length : 0;
          if (Array.isArray(d.txns)) setTxns(d.txns.map((x) => ({ ...x, id: x.id || uid() })));
          if (Array.isArray(d.incomeEntries)) setIncomeEntries(d.incomeEntries.map((x) => ({ ...x, id: x.id || uid() })));
          if (Array.isArray(d.eriEntries)) setEriEntries(d.eriEntries.map((x) => ({ ...x, id: x.id || uid() })));
          if (typeof d.income === "number") setIncome(d.income);
          if (typeof d.carried === "number") setCarried(d.carried);
          if (d.cash && typeof d.cash === "object" && !Array.isArray(d.cash)) setCash(d.cash);
          if (Array.isArray(d.valuations)) setValuations(d.valuations);
          if (d.prices && typeof d.prices === "object") setPrices(d.prices);
          if (d.priceMeta && typeof d.priceMeta === "object") setPriceMeta(d.priceMeta);
          if (typeof d.avKey === "string") setAvKey(d.avKey);
          if (d.avMeta && typeof d.avMeta === "object") setAvMeta(d.avMeta);
          if (d.secMeta && typeof d.secMeta === "object") setSecMeta((m) => ({ ...m, ...d.secMeta }));
          if (Array.isArray(d.pensionCashflows)) setPensionCashflows(d.pensionCashflows.map((x) => ({ ...x, id: x.id || uid() })));
          flash(`Restored: ${n(d.txns)} transactions, ${n(d.incomeEntries)} dividend/interest entries, ${n(d.eriEntries)} ERI entries, ${n(d.pensionCashflows)} pension cashflows, plus prices and settings.`);
        } else {
          setError("That file isn't a recognised backup — expected a transaction array or a full backup file exported from this app.");
        }
      } catch { setError("Couldn't parse that JSON file."); }
    };
    r.readAsText(f);
    e.target.value = ""; // allow re-selecting the same file
  };

  return (
    <div className={dark ? "dark" : ""}>
      <style>{`
        .root{
          --bg:#f6f7f9;--panel:#ffffff;--panel2:#f1f3f6;--fg:#0f1729;--muted:#5b6677;
          --border:#e2e6ec;--accent:#4338ca;--accent-fg:#ffffff;--gain:#047857;--loss:#be123c;
          --m-same:#0369a1;--m-bb:#b45309;--m-pool:#4338ca;--chip:#eef1f6;
        }
        .dark .root{
          --bg:#080b12;--panel:#0f141d;--panel2:#151b26;--fg:#e8edf4;--muted:#8a97a8;
          --border:#222b38;--accent:#6366f1;--accent-fg:#ffffff;--gain:#34d399;--loss:#fb7185;
          --m-same:#38bdf8;--m-bb:#fbbf24;--m-pool:#a5b4fc;--chip:#1a2230;
        }
        .num{font-variant-numeric:tabular-nums;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
        @media print {
          body * { visibility: hidden !important; }
          .print-area, .print-area * { visibility: visible !important; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 24px;
            --bg:#fff; --panel:#fff; --panel2:#f6f7f9; --fg:#000; --muted:#444; --border:#ccc;
            --gain:#065f46; --loss:#9f1239; --accent:#1e293b; }
          .no-print { display: none !important; }
          table { page-break-inside: auto; } tr { page-break-inside: avoid; }
        }
      `}</style>
      <div className="root min-h-screen bg-[var(--bg)] text-[var(--fg)]" style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          {/* header */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                <Receipt size={20} className="text-[var(--accent)]" /> Wealth Dashboard
              </h1>
              <p className="text-sm text-[var(--muted)] mt-0.5">Total wealth across GIA · ISA · SIPP · LISA · VCT, with HMRC-precise CGT (same-day · 30-day · S104). All figures GBP.</p>
            </div>
            <div className="flex items-center gap-2">
              {status && <span className="text-xs text-[var(--muted)] mr-1 max-w-[220px] text-right leading-tight">{status}</span>}
              <IconBtn onClick={exportJSON} title="Full backup: transactions, dividends/interest, ERI, prices and settings (downloads a file; if you've set an Alpha Vantage key it's included in plain text). Also copies to clipboard as a fallback."><Download size={16} /></IconBtn>
              <IconBtn onClick={() => fileRef.current && fileRef.current.click()} title="Restore from a full backup file (or import a legacy transactions-only JSON)"><Upload size={16} /></IconBtn>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={importJSON} />
              <IconBtn onClick={() => setDark((d) => !d)} title="Theme">{dark ? <Sun size={16} /> : <Moon size={16} />}</IconBtn>
            </div>
          </div>

          {/* tabs */}
          <div className="flex flex-wrap gap-1 mt-5 border-b border-[var(--border)]">
            {[["wealth", "Wealth", PieChart], ["returns", "Returns", Percent], ["gilts", "Gilts", Landmark], ["pension", "Pension & LISA", PiggyBank], ["cgt", "CGT", TableProperties], ["holdings", "Holdings", Wallet], ["income", "Income", PoundSterling], ["ledger", "Transactions", Receipt], ["import", "Import CSV", FileUp]].map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)}
                className={"px-3 py-2 text-sm font-medium flex items-center gap-1.5 border-b-2 -mb-px transition " +
                  (tab === k ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]")}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 text-sm rounded-lg px-3 py-2 text-[var(--loss)] border"
              style={{ background: "color-mix(in srgb, var(--loss) 12%, transparent)", borderColor: "color-mix(in srgb, var(--loss) 35%, transparent)" }}>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}

          <div className="mt-5">
            {tab === "wealth" && <WealthTab {...{ model: wealthModel, cash, setCash, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta }} />}
            {tab === "returns" && <ReturnsTab {...{ returns, valuations }} />}
            {tab === "gilts" && <GiltsTab {...{ data: giltData, secMeta, setSecMeta, prices, setPrices }} />}
            {tab === "pension" && <PensionTab {...{ txns, setTxns, cash, setCash, secMeta, setSecMeta, prices, setPrices, pensionCashflows, setPensionCashflows }} />}
            {tab === "cgt" && <CgtSection {...{
              taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried,
              carryForward: allYears.carriedForward, exemptGiltDisposalCount,
              pools: taxablePools, disposals: taxableDisposals, prices, setPrices, txns: giaTxns,
            }} />}
            {tab === "income" && <IncomeTab {...{ incomeEntries, setIncomeEntries, eriEntries, setEriEntries, eriTxns, incomeByYear, incomeAllWrappers, income, setIncome, txns: giaTxns, secMeta, setSecMeta }} />}
            {tab === "holdings" && <HoldingsTab {...{ positions: wealthModel ? wealthModel.positions : [], prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta }} />}
            {tab === "ledger" && <LedgerTab {...{ txns, setTxns }} />}
            {tab === "import" && <ImportTab {...{ setTxns, setTab, setIncomeEntries, setEriEntries, secMeta, setPensionCashflows }} />}
          </div>

          <p className="text-xs text-[var(--muted)] mt-8 leading-relaxed">
            Figures are an estimate to support your own filing, not tax advice. Verify before submitting to HMRC.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Income tab --------------------------- */
const addMonthsISO = (s, n) => {
  if (!s) return "";
  const [y, m, d] = s.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDayOfTarget = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDayOfTarget));
  return target.toISOString().slice(0, 10);
};
const DIV_BLANK = () => ({ id: uid(), date: todayISO(), ticker: "", kind: "dividend", amount: "" });
const ERI_BLANK = () => ({ id: uid(), ticker: "", periodEnd: "", distributionDate: "", perShare: "", currency: "GBp", fxRate: 1, treatment: "dividend" });
const ERI_COLS = [
  { label: "Fund", align: "left" },
  { label: "Period end", align: "left" },
  { label: "Dist. date", align: "left" },
  { label: "Units", align: "right" },
  { label: "ERI (GBP)", align: "right" },
  { label: "Taxed as", align: "left" },
  { label: "Tax year", align: "left" },
  { label: "", align: "right" },
];

function IncomeTab({ incomeEntries, setIncomeEntries, eriEntries, setEriEntries, eriTxns, incomeByYear, incomeAllWrappers = {}, income, setIncome, txns, secMeta, setSecMeta }) {
  const [dv, setDv] = useState(DIV_BLANK());
  const [er, setEr] = useState(ERI_BLANK());
  const [fxBusy, setFxBusy] = useState(false);
  const [sub, setSub] = useState(() => store.get("cgt.incomesubtab", "byyear"));
  React.useEffect(() => store.set("cgt.incomesubtab", sub), [sub]);
  const years = Object.keys(incomeByYear).sort().reverse();
  const allYears = Object.keys(incomeAllWrappers).sort().reverse();
  const presentWrappers = useMemo(() => {
    const set = new Set();
    for (const y of allYears) for (const w of Object.keys(incomeAllWrappers[y])) set.add(w);
    return WRAPPERS.filter((w) => set.has(w));
  }, [allYears, incomeAllWrappers]);
  const [incWrapper, setIncWrapper] = useState(() => store.get("cgt.income.wrapper", "GIA"));
  React.useEffect(() => store.set("cgt.income.wrapper", incWrapper), [incWrapper]);
  React.useEffect(() => { if (presentWrappers.length && !presentWrappers.includes(incWrapper)) setIncWrapper(presentWrappers[0]); }, [presentWrappers]);

  const addDiv = () => { if (!dv.date || !(+dv.amount)) return; setIncomeEntries((p) => [...p, { ...dv, amount: +dv.amount }]); setDv(DIV_BLANK()); };
  const setEriF = (k, v) => setEr((e) => { const n = { ...e, [k]: v }; if (k === "periodEnd") n.distributionDate = addMonthsISO(v, 6); if (k === "currency" && (v === "GBP" || v === "GBp")) n.fxRate = 1; return n; });
  const addEri = () => { if (!er.ticker || !er.periodEnd || !er.distributionDate || !(+er.perShare)) return; setEriEntries((p) => [...p, { ...er, ticker: er.ticker.toUpperCase(), perShare: +er.perShare, fxRate: +er.fxRate || 0 }]); setEr(ERI_BLANK()); };
  const fetchEriFx = async () => {
    if (er.currency === "GBP" || er.currency === "GBp") return;
    setFxBusy(true);
    try { const fx = await fxToGBP(er.currency); if (fx) setEr((e) => ({ ...e, fxRate: +fx.toFixed(6) })); } catch { /* ignore */ }
    setFxBusy(false);
  };
  const eriPreview = (() => {
    const units = unitsHeldAt(txns, er.periodEnd || "9999-12-31", er.ticker);
    const native = units * (+er.perShare || 0);
    const g = er.currency === "GBp" ? native / 100 : er.currency === "GBP" ? native : native * (+er.fxRate || 0);
    return { units, g };
  })();

  return (
    <div className="space-y-5">
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Employment / other income (£)"><input type="number" value={income} onChange={(e) => setIncome(+e.target.value || 0)} className="input num w-48" /></Field>
        <p className="text-xs text-[var(--muted)] pb-2 max-w-md">Dividends and interest are stacked on top of this income for the tax calculation. The tax table counts only taxable (GIA) income; the all-wrapper overview shows your full income including tax-free ISA/SIPP/LISA/VCT.</p>
      </div>

      <SubTabs
        tabs={[["byyear", "Tax by year"], ["divint", "Dividends & interest"], ["eri", "ERI"]]}
        active={sub} onChange={setSub}
      />

      {sub === "byyear" && (
        <div className="space-y-6">
          {/* All-wrapper income overview (taxable + sheltered), one wrapper at a time */}
          {allYears.length ? (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">All investment income by wrapper</h3>
              <div className="flex flex-wrap gap-1.5">
                {presentWrappers.map((w) => (
                  <button key={w} onClick={() => setIncWrapper(w)}
                    className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
                      (incWrapper === w ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
                    {w}
                  </button>
                ))}
              </div>
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                    <tr>{["Tax year", "Dividends", "Interest", "Total"].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                    {allYears.filter((y) => incomeAllWrappers[y][incWrapper]).map((y) => {
                      const d = incomeAllWrappers[y][incWrapper];
                      return (
                        <tr key={y} className="hover:bg-[var(--panel2)]">
                          <td className="py-2 px-3 font-medium">{y}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.dividends)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.interest)}</td>
                          <td className="py-2 px-3 text-right num font-medium">{gbp(d.dividends + d.interest)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--muted)]">{isWrapperTaxable(incWrapper) ? `${incWrapper} is taxable` : `${incWrapper} is tax-free`} — only GIA income feeds the tax calculation below; ISA, SIPP, LISA and VCT income is tax-free (VCT dividends are exempt under ITA 2007 Part 6).</p>
            </div>
          ) : null}

          {/* Per-year income tax (taxable only) */}
          {years.length ? (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Taxable investment income tax by year <span className="font-normal text-[var(--muted)]">(GIA only)</span></h3>
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)]">
                    <tr>{["Tax year", "Dividends", "Interest", "Dividend tax", "Interest tax", "Total"].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {years.map((y) => {
                      const d = incomeByYear[y], r = investmentIncomeTax({ salary: income, interest: d.interest, dividends: d.dividends, year: y });
                      return (
                        <tr key={y}>
                          <td className="py-2 px-3 font-medium">{y}{r.assumed ? " *" : ""}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.dividends)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.interest)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(r.dividendTax)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(r.interestTax)}</td>
                          <td className="py-2 px-3 text-right num font-semibold text-[var(--loss)]">{gbp(r.tax)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--muted)]">Dividend allowance and Personal Savings Allowance are applied automatically by year and band. Figures marked * use assumed (latest) rates for years not in the table.</p>
            </div>
          ) : <Empty msg="No dividends, interest or ERI recorded yet. Add them on the Dividends & Interest or ERI tab to see the income-tax position." />}
        </div>
      )}

      {sub === "divint" && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm">Dividends & interest</h3>
          <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
            <Field label="Date"><input type="date" value={dv.date} onChange={(e) => setDv({ ...dv, date: e.target.value })} className="input num" /></Field>
            <Field label="Ticker (optional)"><input value={dv.ticker} onChange={(e) => setDv({ ...dv, ticker: e.target.value.toUpperCase() })} className="input num w-24" placeholder="—" /></Field>
            <Field label="Type"><select value={dv.kind} onChange={(e) => setDv({ ...dv, kind: e.target.value })} className="input"><option value="dividend">Dividend</option><option value="interest">Interest</option></select></Field>
            <Field label="Amount (£, GBP)"><input type="number" value={dv.amount} onChange={(e) => setDv({ ...dv, amount: e.target.value })} className="input num w-32" placeholder="0.00" /></Field>
            <button onClick={addDiv} className="btn-accent"><Plus size={15} /> Add</button>
          </div>
          {incomeEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] overflow-hidden">
              <table className="w-full text-sm">
                <tbody className="divide-y divide-[var(--border)]">
                  {incomeEntries.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).map((e) => (
                    <tr key={e.id}>
                      <td className="py-2 px-3 num text-[var(--muted)]">{e.date}</td>
                      <td className="py-2 px-3">{e.ticker || "—"}</td>
                      <td className="py-2 px-3 capitalize">{e.kind}</td>
                      <td className="py-2 px-3 num">{ukTaxYear(e.date)}</td>
                      <td className="py-2 px-3 text-right num">{gbp(+e.amount)}</td>
                      <td className="py-2 px-3 text-right"><button onClick={() => setIncomeEntries((p) => p.filter((x) => x.id !== e.id))} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} /></button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {sub === "eri" && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm">Excess reportable income (offshore reporting funds)</h3>
          <p className="text-xs text-[var(--muted)] max-w-3xl">For accumulating ETFs and other offshore reporting funds. Enter the reportable income per share from the fund's report and its reporting-period end. It's taxed on the fund distribution date (period end + 6 months), in that tax year, as dividend (equity funds) or interest (bond funds &gt;60% debt) — and the taxed amount is added to the Section 104 pool, lowering the gain on later disposals.</p>
          <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))" }}>
            <Field label="Ticker"><input value={er.ticker} onChange={(e) => setEriF("ticker", e.target.value.toUpperCase())} className="input num w-full" placeholder="e.g. XNAQ" /></Field>
            <Field label="Reporting period end"><input type="date" value={er.periodEnd} onChange={(e) => setEriF("periodEnd", e.target.value)} className="input num w-full" /></Field>
            <Field label="Fund distribution date"><input type="date" value={er.distributionDate} onChange={(e) => setEriF("distributionDate", e.target.value)} className="input num w-full" /></Field>
            <Field label="Reportable income / share"><input type="number" value={er.perShare} onChange={(e) => setEriF("perShare", e.target.value)} className="input num w-full" placeholder="0.00" /></Field>
            <Field label="Currency"><select value={er.currency} onChange={(e) => setEriF("currency", e.target.value)} className="input w-full">{["GBp", "GBP", "USD", "EUR"].map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field label="FX → GBP">
              <div className="flex gap-1"><input type="number" value={er.fxRate} onChange={(e) => setEriF("fxRate", e.target.value)} disabled={er.currency === "GBP" || er.currency === "GBp"} className="input num w-full disabled:opacity-50" />
                {er.currency !== "GBP" && er.currency !== "GBp" && <button onClick={fetchEriFx} disabled={fxBusy} className="text-[var(--accent)] px-1" title="Fetch latest FX">{fxBusy ? "…" : "↻"}</button>}</div>
            </Field>
            <Field label="Taxed as"><select value={er.treatment} onChange={(e) => setEriF("treatment", e.target.value)} className="input w-full"><option value="dividend">Dividend</option><option value="interest">Interest</option></select></Field>
            <div className="flex items-end"><button onClick={addEri} className="btn-accent w-full justify-center"><Plus size={15} /> Add</button></div>
          </div>
          {er.ticker && er.periodEnd && (
            <p className="text-xs text-[var(--muted)] num">Preview: {num(eriPreview.units, eriPreview.units % 1 ? 4 : 0)} units held at {er.periodEnd} → ERI {gbp(eriPreview.g || 0)} taxed in {er.distributionDate ? ukTaxYear(er.distributionDate) : "—"}.</p>
          )}
          {eriEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--panel2)] text-[var(--muted)]">
                  <tr>{ERI_COLS.map((c, i) => <th key={i} className={"py-2 px-3 font-medium text-" + c.align}>{c.label}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {eriEntries.slice().sort((a, b) => (a.distributionDate < b.distributionDate ? 1 : -1)).map((e) => {
                    const t = eriTxns.find((x) => x.id === "eri-" + e.id);
                    return (
                      <tr key={e.id}>
                        <td className={"py-2 px-3 font-medium text-" + ERI_COLS[0].align}>{e.ticker}</td>
                        <td className={"py-2 px-3 num text-[var(--muted)] text-" + ERI_COLS[1].align}>{e.periodEnd}</td>
                        <td className={"py-2 px-3 num text-[var(--muted)] text-" + ERI_COLS[2].align}>{e.distributionDate}</td>
                        <td className={"py-2 px-3 num text-" + ERI_COLS[3].align}>{t ? num(t._units, t._units % 1 ? 4 : 0) : "—"}</td>
                        <td className={"py-2 px-3 num text-" + ERI_COLS[4].align}>{gbp(t ? t._gbp : 0)}</td>
                        <td className={"py-2 px-3 capitalize text-" + ERI_COLS[5].align}>{e.treatment}</td>
                        <td className={"py-2 px-3 num text-" + ERI_COLS[6].align}>{ukTaxYear(e.distributionDate)}</td>
                        <td className={"py-2 px-3 text-" + ERI_COLS[7].align}><button onClick={() => setEriEntries((p) => p.filter((x) => x.id !== e.id))} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[var(--muted)]">The base-cost uplift shows up automatically in Holdings and the CGT summary. ERI is added to the pool on the distribution date, so it only reduces gains on disposals after that date.</p>

          <EriCoverage {...{ txns, eriEntries, secMeta, setSecMeta }} />
        </div>
      )}
    </div>
  );
}

// For each fund ever held in the GIA (open or fully closed), shows the
// holding window and which calendar years have a recorded ERI entry —
// closed positions are included, since a fund owes ERI for every accounting
// period that fell inside the time it was actually held, not just while
// still open. Funds with no ISIN on record (so ERI-relevance is unknown)
// are flagged for review rather than silently skipped.
function EriCoverage({ txns, eriEntries, secMeta, setSecMeta }) {
  const rows = useMemo(() => {
    const byTicker = {};
    for (const t of txns) {
      if (t.side !== "BUY" && t.side !== "SELL") continue;
      (byTicker[t.ticker] ||= []).push(t);
    }
    const today = todayISO();
    return Object.entries(byTicker).map(([ticker, list]) => {
      list.sort((a, b) => (a.date < b.date ? -1 : 1));
      let qty = 0, firstBuy = null, lastZero = null;
      for (const t of list) {
        if (firstBuy === null && t.side === "BUY") firstBuy = t.date;
        qty += (t.side === "BUY" ? 1 : -1) * t.quantity;
        if (Math.abs(qty) < 1e-6) lastZero = t.date;
      }
      const open = qty > 1e-6;
      const endDate = open ? today : (lastZero || list[list.length - 1].date);
      const startYear = +firstBuy.slice(0, 4), endYear = +endDate.slice(0, 4);
      const years = []; for (let y = startYear; y <= endYear; y++) years.push(y);
      const sec = secMeta[ticker];
      const eriYears = new Set(eriEntries.filter((e) => e.ticker === ticker && e.periodEnd).map((e) => +e.periodEnd.slice(0, 4)));
      const missing = sec?.eri === true ? years.filter((y) => !eriYears.has(y)) : [];
      return { ticker, firstBuy, endDate, open, years, eriYears: [...eriYears].sort(), missing, sec };
    }).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [txns, eriEntries, secMeta]);

  const setISIN = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], isin: v.toUpperCase().trim() } }));
  const setEri = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], eri: v } }));

  if (!rows.length) return null;
  const flagged = rows.filter((r) => r.missing.length > 0 || !r.sec).length;

  return (
    <div className="space-y-3 pt-2">
      <h3 className="text-sm font-semibold flex items-center gap-2"><AlertTriangle size={15} /> ERI coverage check</h3>
      <p className="text-xs text-[var(--muted)]">
        Every fund ever held unsheltered — open and fully closed positions — with the years held and which have a recorded ERI entry. A closed position still owes ERI for any accounting period that fell inside the time it was held.
        {flagged > 0 && ` ${flagged} fund${flagged === 1 ? "" : "s"} need${flagged === 1 ? "s" : ""} a look.`}
      </p>
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--panel2)] text-[var(--muted)]">
            <tr>{["Fund", "ISIN", "Held", "Years covered", "Status"].map((h, i) => <th key={i} className="py-2 px-3 font-medium text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td className="py-2 px-3 font-medium">{r.ticker}</td>
                <td className="py-2 px-3">
                  <input value={r.sec?.isin || ""} onChange={(e) => setISIN(r.ticker, e.target.value)} placeholder="IE00… (unknown)" className="input font-mono text-[10px] w-32 py-1" />
                </td>
                <td className="py-2 px-3 num text-[var(--muted)]">{r.firstBuy} → {r.open ? "now" : r.endDate}</td>
                <td className="py-2 px-3 num text-[var(--muted)]">{r.eriYears.length ? r.eriYears.join(", ") : "none"}</td>
                <td className="py-2 px-3">
                  {!r.sec ? (
                    <span className="inline-flex items-center gap-1 text-[var(--loss)]"><AlertTriangle size={12} /> No ISIN on record — add it to check ERI relevance</span>
                  ) : r.sec.eri === false ? (
                    <span className="text-[var(--muted)]">Not an offshore fund — no ERI</span>
                  ) : r.missing.length ? (
                    <span className="inline-flex items-center gap-1 text-[var(--loss)]"><AlertTriangle size={12} /> Missing: {r.missing.join(", ")}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[var(--gain)]"><Check size={12} /> Covered</span>
                  )}
                  {r.sec && (
                    <button onClick={() => setEri(r.ticker, !r.sec.eri)} className="ml-2 text-[var(--accent)] underline decoration-dotted">
                      {r.sec.eri ? "mark not ERI-relevant" : "mark ERI-relevant"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">
        "Years covered" matches by calendar year of each entry's period end, since fund accounting periods rarely align to UK tax years — it's a coverage indicator, not a substitute for checking each issuer's actual report. UK investment trusts (e.g. investment companies you hold as ordinary shares) never generate ERI; only offshore reporting funds (most Irish/Luxembourg-domiciled ETFs) do.
      </p>
    </div>
  );
}

/* ----------------------------- CGT tab ------------------------------ */
// Groups the four CGT tools (Summary, Planning, Report, What-if) under one
// top-level tab as sub-tabs, since they're all views over the same GIA-only
// CGT computation rather than separate concerns.
function CgtSection(props) {
  const { taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried,
    carryForward, exemptGiltDisposalCount, pools, disposals, prices, setPrices, txns } = props;
  const [sub, setSub] = useState(() => store.get("cgt.cgtsubtab", "summary"));
  React.useEffect(() => store.set("cgt.cgtsubtab", sub), [sub]);
  return (
    <div>
      <SubTabs
        tabs={[["summary", "Summary"], ["planning", "Planning"], ["report", "Report"], ["whatif", "What-if"]]}
        active={sub} onChange={setSub}
      />
      {sub === "summary" && <CgtTab {...{ taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried, carryForward, exemptGiltDisposalCount }} />}
      {sub === "planning" && <PlanningTab {...{ pools, prices, setPrices, disposals, txns, income }} />}
      {sub === "report" && <ReportTab {...{ taxYears, disposals, income, carried }} />}
      {sub === "whatif" && <WhatIfTab {...{ pools, disposals, income, carried, prices }} />}
    </div>
  );
}

function CgtTab({ taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried, carryForward, exemptGiltDisposalCount = 0 }) {
  if (!taxYears.length) return <Empty msg="No disposals yet. Add or import transactions to see a CGT position." />;
  return (
    <div className="space-y-5">
      {exemptGiltDisposalCount > 0 && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--m-same)]" />
          <span>{exemptGiltDisposalCount} gilt disposal{exemptGiltDisposalCount === 1 ? "" : "s"} excluded from every figure below — individual gilts are CGT-exempt (TCGA 1992 s115). See the Gilts tab for their coupon income and accrued interest instead.</span>
        </div>
      )}
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Tax year">
          <select value={activeYear} onChange={(e) => setYear(e.target.value)} className="input num">
            {taxYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <Field label="Annual income before tax (£)"><input type="number" value={income} onChange={(e) => setIncome(+e.target.value || 0)} className="input num w-44" /></Field>
        <Field label="Losses b/f (before tracked years)"><input type="number" value={carried} onChange={(e) => setCarried(+e.target.value || 0)} className="input num w-52" /></Field>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Net gains" value={gbp(liab.net)} tone={liab.net >= 0 ? "gain" : "loss"} />
        <Stat label="Taxable after AEA" value={gbp(liab.taxable)} />
        <Stat label="CGT due" value={gbp(liab.tax)} tone="loss" big />
        <Stat label="Reporting" value={liab.reporting ? "Required" : "Not required"} sub={liab.reporting ? "tax due or proceeds over threshold" : "below thresholds"} />
      </div>

      <div className="text-xs text-[var(--muted)] num">
        Gains {gbp(liab.gains)} · losses {gbp(liab.losses)} · AEA {gbp(liab.aea)}{liab.usedCarried ? ` · carried losses used ${gbp(liab.usedCarried)}` : ""} ·
        {" "}{liab.breakdown.length ? liab.breakdown.map((b) => `${gbp(b.amount)} @ ${fmtRate(b.rate)}`).join(" + ") : "no taxable gain"} · proceeds {gbp(liab.proceeds)}
        {liab.assumed ? " · rates assumed (year not in table)" : ""}
      </div>
      <div className="text-xs text-[var(--muted)] num -mt-3">
        Income {gbp(income)} − personal allowance {gbp(liab.personalAllowance)} = taxable income {gbp(liab.taxableIncome)}; basic-rate band left for gains {gbp(Math.max(0, cfgFor(activeYear).basicLimit - liab.taxableIncome))}.
      </div>
      <div className="rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 text-xs text-[var(--muted)] num -mt-1">
        <span className="font-medium text-[var(--fg)]">Loss pool</span> — brought into {activeYear} {gbp(liab.carriedInto ?? carried)}
        {liab.usedCarried ? ` · used ${gbp(liab.usedCarried)} (only down to the AEA)` : " · none used"}
        {liab.inYearNetLoss ? ` · net loss realised this year ${gbp(liab.inYearNetLoss)}` : ""} · carried out {gbp(liab.carriedOut ?? carried)}.
        {" "}Total unused losses across all tracked years: <span className="font-medium text-[var(--fg)]">{gbp(carryForward || 0)}</span>.
        {carryForward > 0 ? " Remember losses must be claimed within 4 years of the tax year they arose." : ""}
      </div>

      {/* audit trail — the signature element */}
      <div className="space-y-3">
        {yearDisposals.map((d) => (
          <div key={d.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 bg-[var(--panel2)] border-b border-[var(--border)]">
              <div className="flex items-baseline gap-3">
                <span className="font-semibold">{d.ticker}</span>
                <span className="text-sm text-[var(--muted)] num">{d.date} · sold {num(d.quantity, d.quantity % 1 ? 4 : 0)} · proceeds {gbp(d.proceeds)}</span>
              </div>
              <span className={"num font-semibold " + (d.gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(d.gain)}</span>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {d.legs.map((l, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 px-4 py-2 text-sm items-center">
                  <div className="col-span-3"><MethodChip m={l.method} /></div>
                  <div className="col-span-2 num text-[var(--muted)]">{num(l.quantity, l.quantity % 1 ? 4 : 0)} sh{l.matchedAcqDate ? "" : ""}</div>
                  <div className="col-span-3 num text-right">cost {gbp(l.cost)}</div>
                  <div className="col-span-2 num text-right text-[var(--muted)]">{gbp(l.proceeds)}</div>
                  <div className={"col-span-2 num text-right font-medium " + (l.gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(l.gain)}</div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* --------------------------- Ledger tab ----------------------------- */
const BLANK = () => ({ id: uid(), date: todayISO(), ticker: "", side: "BUY", quantity: "", nativeCurrency: "GBP", nativeAmount: "", fxRate: 1, gbpAmount: "", wrapper: "GIA", note: "" });
function LedgerTab({ txns, setTxns }) {
  const [draft, setDraft] = useState(BLANK());
  const [fxBusy, setFxBusy] = useState(false);

  const set = (k, v) => setDraft((d) => {
    const next = { ...d, [k]: v };
    if (["nativeAmount", "fxRate"].includes(k)) {
      const na = +next.nativeAmount || 0, fx = +next.fxRate || 0;
      if (na && fx) next.gbpAmount = +(na * fx).toFixed(2);
    }
    if (k === "nativeCurrency" && v === "GBP") { next.fxRate = 1; if (next.nativeAmount) next.gbpAmount = +next.nativeAmount; }
    return next;
  });

  const fetchFx = async () => {
    if (draft.nativeCurrency === "GBP") return;
    setFxBusy(true);
    try {
      const res = await fetch(`https://api.frankfurter.dev/v1/${draft.date}?from=${draft.nativeCurrency}&to=GBP`);
      const j = await res.json();
      const rate = j?.rates?.GBP;
      if (rate) set("fxRate", +rate.toFixed(6));
    } catch { /* offline / blocked — keep manual */ }
    setFxBusy(false);
  };

  const add = () => {
    if (!draft.ticker || !draft.date || !(+draft.quantity > 0)) return;
    const t = { ...draft, ticker: draft.ticker.toUpperCase().trim(), quantity: +draft.quantity, nativeAmount: +draft.nativeAmount || 0, fxRate: +draft.fxRate || 1, gbpAmount: +draft.gbpAmount || 0 };
    setTxns((p) => [...p, t]); setDraft(BLANK());
  };
  // Editing a transaction recomputes gbpAmount from native × fx when either
  // changes (same rule as the add-row form), unless gbpAmount itself was the
  // field just edited — keeps both paths (typing GBP directly, or typing
  // native+fx) working without one silently overwriting the other.
  const updateTxn = (id, patch) => setTxns((all) => all.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, ...patch };
    if ("nativeAmount" in patch || "fxRate" in patch) {
      const na = +next.nativeAmount || 0, fx = +next.fxRate || 0;
      if (na && fx) next.gbpAmount = +(na * fx).toFixed(2);
    }
    if (patch.nativeCurrency === "GBP") { next.fxRate = 1; if (next.nativeAmount) next.gbpAmount = +next.nativeAmount; }
    return next;
  }));
  const rows = [...txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return (
    <div className="space-y-4">
      {/* add row */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="grid grid-cols-2 sm:grid-cols-9 gap-2 items-end">
          <Field label="Date"><input type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} className="input num w-full" /></Field>
          <Field label="Ticker"><input value={draft.ticker} onChange={(e) => set("ticker", e.target.value)} placeholder="WFC" className="input w-full" /></Field>
          <Field label="Side">
            <select value={draft.side} onChange={(e) => set("side", e.target.value)} className="input w-full"><option>BUY</option><option>SELL</option></select>
          </Field>
          <Field label="Wrapper">
            <select value={draft.wrapper} onChange={(e) => set("wrapper", e.target.value)} className="input w-full">{WRAPPERS.map((w) => <option key={w}>{w}</option>)}</select>
          </Field>
          <Field label="Quantity"><input type="number" value={draft.quantity} onChange={(e) => set("quantity", e.target.value)} className="input num w-full" /></Field>
          <Field label="Ccy">
            <select value={draft.nativeCurrency} onChange={(e) => set("nativeCurrency", e.target.value)} className="input w-full">
              {["GBP", "USD", "EUR", "CHF"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Native amount"><input type="number" value={draft.nativeAmount} onChange={(e) => set("nativeAmount", e.target.value)} className="input num w-full" /></Field>
          <Field label={<span className="flex items-center gap-1">FX→GBP {draft.nativeCurrency !== "GBP" && <button onClick={fetchFx} title="Fetch ECB rate for date" className="text-[var(--accent)]">{fxBusy ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}</button>}</span>}>
            <input type="number" value={draft.fxRate} onChange={(e) => set("fxRate", e.target.value)} disabled={draft.nativeCurrency === "GBP"} className="input num w-full disabled:opacity-50" />
          </Field>
          <Field label="GBP amount"><input type="number" value={draft.gbpAmount} onChange={(e) => set("gbpAmount", e.target.value)} className="input num w-full" /></Field>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-[var(--muted)]">{draft.nativeCurrency !== "GBP" ? "GBP auto-computes from native × rate; both stay editable." : "GBP transaction — rate fixed at 1."}</span>
          <button onClick={add} className="btn-accent"><Plus size={15} /> Add transaction</button>
        </div>
      </div>

      {/* table — every field editable inline; edits recompute GBP from native×fx same as the add form */}
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Date", "Ticker", "Side", "Wrapper", "Qty", "Ccy", "Native", "FX", "GBP", ""].map((h, i) => <th key={i} className={"px-1.5 py-1.5 font-medium " + (i >= 4 ? "text-right" : "text-left")}>{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {rows.map((t) => {
              const isGBP = (t.nativeCurrency || "GBP") === "GBP";
              return (
                <tr key={t.id} className="hover:bg-[var(--panel2)]">
                  <td className="px-1 py-1"><input type="date" value={t.date} onChange={(e) => updateTxn(t.id, { date: e.target.value })} className="input num w-[8.5rem] py-0.5 text-xs" /></td>
                  <td className="px-1 py-1"><input value={t.ticker} onChange={(e) => updateTxn(t.id, { ticker: e.target.value.toUpperCase() })} className="input w-16 py-0.5 text-xs font-medium" /></td>
                  <td className="px-1 py-1">
                    <select value={t.side} onChange={(e) => updateTxn(t.id, { side: e.target.value })}
                      className={"input w-[4.5rem] py-0.5 text-xs font-semibold " + (t.side === "BUY" ? "text-[var(--gain)]" : "text-[var(--loss)]")}>
                      <option>BUY</option><option>SELL</option>
                    </select>
                  </td>
                  <td className="px-1 py-1">
                    <select value={normWrapper(t.wrapper)} onChange={(e) => updateTxn(t.id, { wrapper: e.target.value })} className="input w-[4.5rem] py-0.5 text-xs">
                      {WRAPPERS.map((w) => <option key={w}>{w}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1 text-right"><input type="number" value={t.quantity} onChange={(e) => updateTxn(t.id, { quantity: +e.target.value || 0 })} className="input num w-20 py-0.5 text-xs text-right" /></td>
                  <td className="px-1 py-1">
                    <select value={t.nativeCurrency || "GBP"} onChange={(e) => updateTxn(t.id, { nativeCurrency: e.target.value })} className="input w-16 py-0.5 text-xs">
                      {["GBP", "USD", "EUR", "CHF"].map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="px-1 py-1 text-right">
                    <input type="number" value={isGBP ? t.gbpAmount : t.nativeAmount} disabled={isGBP} onChange={(e) => updateTxn(t.id, { nativeAmount: +e.target.value || 0 })} className="input num w-20 py-0.5 text-xs text-right disabled:opacity-50" />
                  </td>
                  <td className="px-1 py-1 text-right">
                    <input type="number" value={t.fxRate ?? 1} disabled={isGBP} onChange={(e) => updateTxn(t.id, { fxRate: +e.target.value || 0 })} className="input num w-16 py-0.5 text-xs text-right disabled:opacity-50" />
                  </td>
                  <td className="px-1 py-1 text-right"><input type="number" value={t.gbpAmount} onChange={(e) => updateTxn(t.id, { gbpAmount: +e.target.value || 0 })} className="input num w-20 py-0.5 text-xs text-right font-medium" /></td>
                  <td className="px-1 py-1 text-right"><button onClick={() => setTxns((p) => p.filter((x) => x.id !== t.id))} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={13} /></button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------- Live prices (Alpha Vantage) ---------------- */
function LivePricesPanel({ tickers, avKey, setAvKey, avMeta, setAvMeta, prices, setPrices, priceMeta, setPriceMeta, txns, secMeta = {} }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState("");
  const [msg, setMsg] = useState("");

  // Individual gilts aren't on Yahoo/Alpha Vantage — verified, not assumed
  // (see api/gilt-prices.mjs) — so they're fetched from the DMO instead,
  // wherever they show up in a price list (Wealth tab included, not just Gilts).
  const giltTickers = tickers.filter((tk) => secMeta[tk]?.kind === "gilt");
  const otherTickers = tickers.filter((tk) => secMeta[tk]?.kind !== "gilt");

  const ledgerCcy = useMemo(() => {
    const m = {}; for (const t of txns) if (!m[t.ticker] && t.nativeCurrency) m[t.ticker] = t.nativeCurrency; return m;
  }, [txns]);
  const defYahoo = (tk) => (ledgerCcy[tk] === "GBP" ? `${tk}.L` : tk);   // Yahoo LSE suffix = .L
  const defAv = (tk) => (ledgerCcy[tk] === "GBP" ? `${tk}.LON` : tk);    // Alpha Vantage LSE suffix = .LON
  const defCcy = (tk) => (ledgerCcy[tk] === "USD" ? "USD" : ledgerCcy[tk] === "EUR" ? "EUR" : "GBp");
  const meta = (tk) => ({
    yahoo: avMeta[tk]?.yahoo ?? defYahoo(tk),
    av: avMeta[tk]?.av ?? avMeta[tk]?.symbol ?? defAv(tk),
    currency: avMeta[tk]?.currency ?? defCcy(tk),
  });
  const setMeta = (tk, patch) => setAvMeta((m) => ({ ...m, [tk]: { ...meta(tk), ...patch } }));
  const used = avBudget().n;

  const applyQuote = (tk, raw, ccy, fx, source) => {
    const g = toGBP(raw, ccy, fx);
    if (g == null) { setMsg(`${tk}: couldn't convert ${ccy} to GBP`); return false; }
    setPrices((p) => ({ ...p, [tk]: +g.toFixed(4) }));
    setPriceMeta((p) => ({ ...p, [tk]: { asOf: new Date().toISOString(), raw, ccy, source } }));
    return true;
  };
  const yahooFetch = async (syms) => {
    const r = await fetch(`/api/quotes?symbols=${encodeURIComponent(syms.join(","))}`);
    if (!r.ok) throw new Error(`function ${r.status}`);
    const j = await r.json();
    const by = {}; (j.quotes || []).forEach((q) => { by[q.symbol] = q; });
    return by;
  };

  const fetchOne = async (tk) => {
    setBusy(true); setProg(`Fetching ${tk}...`); setMsg("");
    if (secMeta[tk]?.kind === "gilt") {
      try {
        const { pricesByTicker, matched, date } = await fetchDmoGiltPrices([{ ticker: tk, isin: secMeta[tk]?.isin }]);
        if (matched) {
          setPrices((p) => ({ ...p, [tk]: pricesByTicker[tk] }));
          setPriceMeta((p) => ({ ...p, [tk]: { asOf: new Date().toISOString(), raw: pricesByTicker[tk] * 100, ccy: "GBP", source: "DMO" } }));
          setMsg(`${tk}: clean price ${gbp(pricesByTicker[tk] * 100)}/£100 nominal from DMO (${date})`);
        } else setMsg(`${tk}: not in today's DMO report — try again after ~2pm, or enter manually.`);
      } catch (e) { setMsg(`${tk}: ${e.message}`); }
      setBusy(false); setProg(""); return;
    }
    const m = meta(tk);
    try {
      const q = (await yahooFetch([m.yahoo]))[m.yahoo];
      if (q && q.price != null) {
        const fx = await fxToGBP(q.currency);
        if (applyQuote(tk, q.price, q.currency, fx, "Yahoo")) { setMsg(`${tk}: ${num(q.price, 2)} ${q.currency} to ${gbp(toGBP(q.price, q.currency, fx))} (Yahoo)`); setBusy(false); setProg(""); return; }
      }
    } catch { /* fall through to AV */ }
    if (avKey && avBudget().n < 25) {
      try {
        const raw = await avQuote(m.av, avKey); avBump();
        const fx = await fxToGBP(m.currency);
        if (applyQuote(tk, raw, m.currency, fx, "AV")) { setMsg(`${tk}: ${num(raw, 2)} ${m.currency} to ${gbp(toGBP(raw, m.currency, fx))} (Alpha Vantage)`); setBusy(false); setProg(""); return; }
      } catch (e) { setMsg(`${tk}: ${e.message}`); setBusy(false); setProg(""); return; }
    }
    setMsg(`${tk}: no live price (deploy the Yahoo function${avKey ? "" : "; no AV key set"}) - enter manually.`);
    setBusy(false); setProg("");
  };

  const fetchAll = async () => {
    setBusy(true); setMsg(""); const done = {}; const fxCache = {};
    const getFx = async (ccy) => { if (ccy === "GBP" || ccy === "GBp") return 1; if (!(ccy in fxCache)) fxCache[ccy] = await fxToGBP(ccy); return fxCache[ccy]; };
    let giltMsg = "";
    if (giltTickers.length) {
      setProg("Fetching gilts from the DMO...");
      try {
        const { pricesByTicker, matched, date } = await fetchDmoGiltPrices(giltTickers.map((tk) => ({ ticker: tk, isin: secMeta[tk]?.isin })));
        if (Object.keys(pricesByTicker).length) {
          setPrices((p) => ({ ...p, ...pricesByTicker }));
          setPriceMeta((p) => { const n = { ...p }; for (const tk of Object.keys(pricesByTicker)) n[tk] = { asOf: new Date().toISOString(), raw: pricesByTicker[tk] * 100, ccy: "GBP", source: "DMO" }; return n; });
          for (const tk of Object.keys(pricesByTicker)) done[tk] = true;
        }
        giltMsg = `${matched}/${giltTickers.length} gilt${giltTickers.length === 1 ? "" : "s"} from DMO (${date})`;
      } catch (e) { giltMsg = `gilts: ${e.message}`; }
    }
    try {
      setProg("Fetching from Yahoo...");
      const by = await yahooFetch(otherTickers.map((tk) => meta(tk).yahoo));
      for (const tk of otherTickers) { const q = by[meta(tk).yahoo]; if (q && q.price != null) { const fx = await getFx(q.currency); if (applyQuote(tk, q.price, q.currency, fx, "Yahoo")) done[tk] = true; } }
    } catch { setMsg("Yahoo function unreachable - trying Alpha Vantage fallback."); }
    const rest = otherTickers.filter((tk) => !done[tk]);
    if (rest.length && avKey) {
      for (let i = 0; i < rest.length; i++) {
        if (avBudget().n >= 25) { setMsg("Alpha Vantage daily limit reached - enter the rest manually."); break; }
        const tk = rest[i], m = meta(tk); setProg(`Alpha Vantage fallback ${i + 1}/${rest.length}: ${tk}...`);
        try { const raw = await avQuote(m.av, avKey); avBump(); const fx = await getFx(m.currency); if (applyQuote(tk, raw, m.currency, fx, "AV")) done[tk] = true; }
        catch (e) { if (/limit/i.test(e.message)) { setMsg("Alpha Vantage limit reached - stopping."); break; } }
        if (i < rest.length - 1) { setProg("Waiting (AV 5/min)..."); await sleep(13000); }
      }
    }
    const got = Object.keys(done).length;
    setProg(""); setMsg(`Updated ${got}/${tickers.length} prices${got < tickers.length ? " - enter the rest manually." : "."}${giltMsg ? ` (${giltMsg})` : ""}`);
    setBusy(false);
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)]">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center justify-between px-4 py-2.5 text-sm">
        <span className="font-medium flex items-center gap-2"><RefreshCw size={14} className="text-[var(--accent)]" /> Live prices <span className="text-xs font-normal text-[var(--muted)]">- {giltTickers.length ? "DMO for gilts, " : ""}Yahoo then Alpha Vantage then manual</span></span>
        <span className="text-xs text-[var(--muted)]">{open ? "hide" : "set up"}</span>
      </button>
      {open && (
        <div className="px-4 pb-4 space-y-3 border-t border-[var(--border)] pt-3">
          <div className="flex items-end gap-2 flex-wrap">
            <button onClick={fetchAll} disabled={busy} className="btn-accent disabled:opacity-50"><RefreshCw size={15} className={busy ? "animate-spin" : ""} /> Fetch prices</button>
            {(prog || msg) && <span className="text-xs text-[var(--muted)] pb-2">{prog || msg}</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-[var(--muted)]">
                <tr>{["Ticker", "Yahoo symbol", "AV symbol", "Ccy (AV)", "", "Last quote", "Source", "As of"].map((h, i) => <th key={i} className="py-1 px-2 font-medium text-left">{h}</th>)}</tr>
              </thead>
              <tbody>
                {tickers.map((tk) => {
                  const isGilt = secMeta[tk]?.kind === "gilt";
                  const m = meta(tk), pm = priceMeta[tk];
                  return (
                    <tr key={tk} className="border-t border-[var(--border)]">
                      <td className="py-1 px-2 font-medium">{tk}</td>
                      {isGilt ? (
                        <td className="py-1 px-2 text-[var(--muted)]" colSpan={3}>DMO (via ISIN {secMeta[tk]?.isin || "— not set"})</td>
                      ) : (<>
                        <td className="py-1 px-2"><input value={m.yahoo} onChange={(e) => setMeta(tk, { yahoo: e.target.value.trim() })} className="input num w-24 py-0.5" /></td>
                        <td className="py-1 px-2"><input value={m.av} onChange={(e) => setMeta(tk, { av: e.target.value.trim() })} className="input num w-24 py-0.5" /></td>
                        <td className="py-1 px-2">
                          <select value={m.currency} onChange={(e) => setMeta(tk, { currency: e.target.value })} className="input py-0.5">
                            {["GBp", "GBP", "USD", "EUR"].map((c) => <option key={c} value={c}>{c}</option>)}
                          </select>
                        </td>
                      </>)}
                      <td className="py-1 px-2"><button onClick={() => fetchOne(tk)} disabled={busy} className="text-[var(--accent)] disabled:opacity-40" title="Fetch this one">&#8635;</button></td>
                      <td className="py-1 px-2 num text-[var(--muted)]">{pm ? `${num(pm.raw, 2)} ${pm.ccy}` : "-"}</td>
                      <td className="py-1 px-2">{pm?.source ? <span className="text-[10px] px-1.5 py-0.5 rounded-full" style={{ color: pm.source === "Yahoo" ? "var(--m-pool)" : pm.source === "DMO" ? "var(--gain)" : "var(--m-bb)", background: "var(--chip)" }}>{pm.source}</span> : <span className="text-[var(--muted)]">-</span>}</td>
                      <td className="py-1 px-2 num text-[var(--muted)]">{pm ? new Date(pm.asOf).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <details className="text-xs">
            <summary className="cursor-pointer text-[var(--muted)]">Alpha Vantage fallback key ({used}/25 used today)</summary>
            <div className="mt-2">
              <Field label="Alpha Vantage key - used only if Yahoo fails (saved on this device)">
                <input type="password" value={avKey} onChange={(e) => setAvKey(e.target.value.trim())} placeholder="paste your Alpha Vantage key" className="input num w-64" />
              </Field>
            </div>
          </details>

          <p className="text-xs text-[var(--muted)] leading-relaxed">
            Yahoo is primary - it returns each quote's currency, so GBP normalisation is automatic (pence /100, USD/EUR via ECB rates) with no daily cap. It needs the <span className="font-medium">/api/quotes</span> serverless function deployed (LSE symbols use the <span className="font-medium">.L</span> suffix). If Yahoo is down or misses a symbol, Alpha Vantage fills in silently using the AV symbol (<span className="font-medium">.LON</span>) and the currency you set per line, capped at 25 calls/day. Anything neither can price, you enter by hand. Check "Last quote" against a price you know if a value looks off.
          </p>
        </div>
      )}
    </div>
  );
}

/* --------------------------- Wealth tab ----------------------------- */
// The "see everything" home view (build step 2): total wealth, per-wrapper and
// consolidated holdings, allocation. Pure view — every figure comes from the
// node-tested wealth core (core/portfolio.mjs), not from view-side arithmetic.
const KIND_LABEL = { equity: "Equities", fund: "Funds (ETF)", investment_trust: "Investment trusts", gilt: "Gilts", bond_fund: "Bond funds", cash: "Cash", unknown: "Unclassified" };
const ALLOC_COLORS = ["var(--accent)", "var(--m-same)", "var(--m-bb)", "var(--gain)", "var(--m-pool)", "var(--loss)"];

function AllocBar({ title, buckets, labelOf = (k) => k }) {
  if (!buckets.length) return null;
  return (
    <div>
      <div className="text-xs font-medium text-[var(--muted)] mb-1.5">{title}</div>
      <div className="flex h-2.5 rounded-full overflow-hidden bg-[var(--panel2)]">
        {buckets.map((b, i) => (
          <div key={b.key} title={`${labelOf(b.key)}: ${gbp(b.marketValue)} (${num(b.pct * 100, 1)}%)`}
            style={{ width: `${Math.max(b.pct * 100, 0.5)}%`, background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-xs">
        {buckets.map((b, i) => (
          <span key={b.key} className="flex items-center gap-1 text-[var(--muted)]">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: ALLOC_COLORS[i % ALLOC_COLORS.length] }} />
            {labelOf(b.key)} <span className="num">{num(b.pct * 100, 1)}%</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function WealthTab({ model, cash, setCash, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta }) {
  if (!model) return <Empty msg="Couldn't build the portfolio model — check the Transactions tab for ledger errors." />;
  const { positions, byWrapper, total, income } = model;
  if (!positions.length && !Object.keys(cash).length)
    return <Empty msg="No holdings yet. Add transactions (any wrapper — GIA, ISA, SIPP, LISA, VCT) on the Transactions or Import tab, and cash balances below will appear here." />;

  const tickers = [...new Set(positions.map((p) => p.ticker))].sort();
  const wrapperOrder = [...WRAPPERS, ...Object.keys(byWrapper).filter((w) => !WRAPPERS.includes(w))].filter((w) => byWrapper[w]);
  const setWrapperCash = (w, v) => setCash((c) => { const n = { ...c }; if (v === "" || isNaN(+v)) delete n[w]; else n[w] = +v; return n; });

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Total wealth" value={gbp(total.total)} sub={`${total.positions} holding${total.positions === 1 ? "" : "s"} + cash across ${wrapperOrder.length} wrapper${wrapperOrder.length === 1 ? "" : "s"}`} big />
        <Stat label="Invested (priced)" value={total.priced ? gbp(total.marketValue) : "—"} sub={total.unpriced ? `${total.priced}/${total.positions} priced` : "all priced"} />
        <Stat label="Cash" value={gbp(total.cash)} />
        <Stat label="Unrealised gain" value={total.priced ? gbp(total.unrealised) : "—"} sub={total.bookCostPriced ? `${total.unrealised >= 0 ? "+" : ""}${num((total.unrealised / total.bookCostPriced) * 100)}% on priced book cost` : undefined} tone={total.unrealised >= 0 ? "gain" : "loss"} />
      </div>

      {total.unpriced > 0 && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span>{total.unpriced} holding{total.unpriced === 1 ? "" : "s"} without a price ({total.unpricedTickers.join(", ")}) — excluded from market value and allocation until priced. Fetch live prices below or type a price into the table.</span>
        </div>
      )}

      <LivePricesPanel {...{ tickers, avKey, setAvKey, avMeta, setAvMeta, prices, setPrices, priceMeta, setPriceMeta, txns, secMeta }} />

      {/* per-wrapper roll-up with editable cash */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Holdings", "Book cost", "Market value", "Unrealised", "Cash", "Total"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {wrapperOrder.map((w) => {
              const a = byWrapper[w];
              return (
                <tr key={w} className="hover:bg-[var(--panel2)]">
                  <td className="px-3 py-2">
                    <span className="font-medium">{w}</span>
                    <span className={"ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded " + (a.taxable ? "bg-[var(--chip)] text-[var(--fg)]" : "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]")}>{a.taxable ? "taxable" : "sheltered"}</span>
                  </td>
                  <td className="px-3 py-2 num text-right">{a.positions}{a.unpriced ? <span className="text-[var(--m-bb)]" title={`${a.unpriced} unpriced`}> *</span> : null}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(a.bookCost)}</td>
                  <td className="px-3 py-2 num text-right">{a.priced ? gbp(a.marketValue) : "—"}</td>
                  <td className={"px-3 py-2 num text-right " + (a.priced ? (a.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]") : "text-[var(--muted)]")}>{a.priced ? gbp(a.unrealised) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <CurrencyInput value={cash[w] ?? 0} onChange={(v) => setWrapperCash(w, v)} className="w-32 ml-auto" />
                  </td>
                  <td className="px-3 py-2 num text-right font-medium">{gbp(a.total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-[var(--panel2)]">
            <tr className="font-medium">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 num text-right">{total.positions}</td>
              <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(total.bookCost)}</td>
              <td className="px-3 py-2 num text-right">{total.priced ? gbp(total.marketValue) : "—"}</td>
              <td className={"px-3 py-2 num text-right " + (total.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{total.priced ? gbp(total.unrealised) : "—"}</td>
              <td className="px-3 py-2 num text-right">{gbp(total.cash)}</td>
              <td className="px-3 py-2 num text-right">{gbp(total.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* allocation */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-4">
        <div className="text-sm font-medium flex items-center gap-2"><PieChart size={15} className="text-[var(--accent)]" /> Allocation <span className="text-xs font-normal text-[var(--muted)]">— by priced market value; unpriced holdings excluded</span></div>
        <AllocBar title="By wrapper" buckets={model.allocation.wrapper} />
        <AllocBar title="By asset class" buckets={model.allocation.assetClass} labelOf={(k) => KIND_LABEL[k] || k} />
        <AllocBar title="By native currency" buckets={model.allocation.currency} />
        <AllocBar title="By fund domicile" buckets={model.allocation.geography} labelOf={(k) => (k === "unknown" ? "Unset" : k)} />
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Currency is each line's native trading currency (a proxy for listing, not look-through exposure — a USD-quoted S&amp;P 500 ETF and a GBP-quoted one hold the same underlying). Domicile comes from the ISIN registry (IE = Irish-domiciled fund, GB = UK). Look-through asset/geography exposure would need fund-holdings data — out of scope for now.
        </p>
      </div>

      {/* consolidated holdings */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Ticker", "Quantity", "Avg cost", "Book cost", "Price now", "Market value", "Unrealised", "%"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i <= 1 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {positions.map((p) => (
              <tr key={p.wrapper + p.ticker} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2">
                  <WrapperChip wrapper={p.wrapper} />
                </td>
                <td className="px-3 py-2 font-medium">
                  <div className="flex items-center gap-1.5">
                    <span>{p.ticker}</span>
                    {p.cgtExempt && <span title="CGT-exempt instrument (individual gilt, TCGA 1992 s115)" className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-same)_18%,transparent)] text-[var(--m-same)] align-middle">CGT-free</span>}
                  </div>
                  {p.name && <div className="text-xs font-normal text-[var(--muted)] truncate max-w-[220px]" title={p.name}>{p.name}</div>}
                </td>
                <td className="px-3 py-2 num text-right">{num(p.qty, p.qty % 1 ? 2 : 0)}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(p.avgCost)}</td>
                <td className="px-3 py-2 num text-right">{gbp(p.bookCost)}</td>
                <td className="px-3 py-2 text-right">
                  <input type="number" value={prices[p.ticker] ?? ""} placeholder="—"
                    onChange={(e) => setPrices((pr) => ({ ...pr, [p.ticker]: e.target.value === "" ? undefined : +e.target.value }))}
                    className="input num w-24 text-right py-1" />
                </td>
                <td className="px-3 py-2 num text-right">{p.priced ? gbp(p.marketValue) : "—"}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (!p.priced ? "text-[var(--muted)]" : p.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{p.priced ? gbp(p.unrealised) : "—"}</td>
                <td className={"px-3 py-2 num text-right " + (!p.priced || p.unrealisedPct == null ? "text-[var(--muted)]" : p.unrealisedPct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{p.priced && p.unrealisedPct != null ? `${p.unrealisedPct >= 0 ? "+" : ""}${num(p.unrealisedPct * 100)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* income strip */}
      {income.total.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Income (all wrappers)" value={gbp(income.total.total)} sub="dividends + interest + ERI, gross" />
          <Stat label="of which dividends" value={gbp(income.total.dividends)} />
          <Stat label="of which interest" value={gbp(income.total.interest)} />
          <Stat label="Taxable (GIA only)" value={gbp(income.total.taxableTotal)} sub="what the Income tab computes tax on" />
        </div>
      )}

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        This view rolls up every wrapper; a price entered here is the same price the GIA-only Holdings tab uses (prices are per ticker, GBP). Cash balances are per wrapper, entered manually, and count toward total wealth. Tax stays gated where it belongs: only GIA holdings feed the CGT and Income tabs, and CGT-exempt instruments are flagged. Same ticker in two wrappers = two independent Section 104 pools, as HMRC requires only for the unsheltered one — sheltered pools reuse the same engine purely for book-cost consistency.
      </p>
    </div>
  );
}

/* --------------------------- Returns tab ---------------------------- */
// Returns & income analytics (build step 3). Pure view over computeReturns()
// (core/returns.mjs) — XIRR everywhere, per-holding TWR, snapshot-based
// portfolio TWR, trailing vs forward income yields. Everything pre-tax.
const pct = (x, dp = 1) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${num(x * 100, dp)}%`);
const pctPlain = (x, dp = 2) => (x == null ? "—" : `${num(x * 100, dp)}%`);
const toneOf = (x) => (x == null ? undefined : x >= 0 ? "gain" : "loss");
const SHORT_SPAN = 90; // days below which an annualised rate is mostly noise

function RateCell({ r }) {
  if (!r || r.rate == null) return <span className="text-[var(--muted)]" title={r?.reason || ""}>—</span>;
  const shortSpan = (r.spanDays ?? 9999) < SHORT_SPAN;
  return (
    <span className={"num " + (r.rate >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}
      title={shortSpan ? `Only ${r.spanDays} days of history — annualised figures this young are noise` : `${r.spanDays} days of history`}>
      {pct(r.rate)}{shortSpan && <span className="text-[var(--m-bb)]" title="Short history">†</span>}
    </span>
  );
}

function ReturnsTab({ returns, valuations }) {
  if (!returns) return <Empty msg="Couldn't compute returns — check the Transactions tab for ledger errors." />;
  const { perHolding, byWrapper, total, portfolioTWR } = returns;
  if (!perHolding.length) return <Empty msg="No transactions yet. Returns appear once you have holdings (any wrapper)." />;

  const wrapperOrder = [...WRAPPERS, ...Object.keys(byWrapper).filter((w) => !WRAPPERS.includes(w))].filter((w) => byWrapper[w]);
  const openH = perHolding.filter((h) => h.open), closedH = perHolding.filter((h) => !h.open);

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Money-weighted return (XIRR)" value={total.xirr.rate != null ? pct(total.xirr.rate) : "—"} sub={total.xirr.rate != null ? "annualised, since first transaction" : total.xirr.reason} tone={toneOf(total.xirr.rate)} big />
        <Stat label="Total profit" value={total.profit != null ? gbp(total.profit) : "—"} sub={total.profit != null && total.moneyIn > 0 ? `${pct(total.simpleReturn)} simple, on ${gbp(total.moneyIn)} in` : undefined} tone={toneOf(total.profit)} />
        <Stat label="Income yield (trailing 12m)" value={pctPlain(total.actualYield)} sub={total.trailing12m ? `${gbp(total.trailing12m)} received incl. ERI` : "no income in the last year"} />
        <Stat label="Income yield (forward)" value={pctPlain(total.forwardYield)} sub={total.forwardIncome ? `${gbp(total.forwardIncome)} est. on current units` : undefined} />
      </div>

      {/* portfolio TWR from snapshots */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-sm font-medium flex items-center gap-2"><Percent size={15} className="text-[var(--accent)]" /> Portfolio time-weighted return
          <span className="text-xs font-normal text-[var(--muted)]">— exact, from valuation snapshots</span>
        </div>
        {portfolioTWR.twr != null ? (
          <div className="mt-2 flex items-baseline gap-4 flex-wrap">
            <span className={"text-lg font-semibold num " + (portfolioTWR.twr >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{pct(portfolioTWR.twr)}</span>
            <span className="text-xs text-[var(--muted)] num">{portfolioTWR.from} → {portfolioTWR.to} ({portfolioTWR.spanDays}d, {portfolioTWR.periods.length} period{portfolioTWR.periods.length === 1 ? "" : "s"})
              {portfolioTWR.annualised != null && portfolioTWR.spanDays >= SHORT_SPAN && <> · {pct(portfolioTWR.annualised)} annualised</>}
            </span>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            Not available yet — {portfolioTWR.reason}. The app records a snapshot of total market value each day all your holdings are priced (currently {valuations.length} snapshot{valuations.length === 1 ? "" : "s"}); portfolio TWR appears once two or more exist and is exact between them, rather than approximated from stale prices. Per-holding TWR below doesn't need this — it's exact from your trade prices.
          </p>
        )}
      </div>

      {/* per-wrapper */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Money in", "Money out + income", "Value now", "Profit", "Simple", "XIRR", "Yield 12m", "Yield fwd"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {wrapperOrder.map((w) => {
              const a = byWrapper[w];
              return (
                <tr key={w} className="hover:bg-[var(--panel2)]">
                  <td className="px-3 py-2 font-medium">{w}{a.unpricedOpen > 0 && <span className="text-[var(--m-bb)]" title={`${a.unpricedOpen} open holding(s) unpriced — profit/XIRR unavailable`}> *</span>}</td>
                  <td className="px-3 py-2 num text-right">{gbp(a.moneyIn)}</td>
                  <td className="px-3 py-2 num text-right">{gbp(a.moneyOut + a.income)}</td>
                  <td className="px-3 py-2 num text-right">{a.unpricedOpen ? "—" : gbp(a.value)}</td>
                  <td className={"px-3 py-2 num text-right font-medium " + (a.profit == null ? "text-[var(--muted)]" : a.profit >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{a.profit != null ? gbp(a.profit) : "—"}</td>
                  <td className="px-3 py-2 num text-right">{pct(a.simpleReturn)}</td>
                  <td className="px-3 py-2 text-right"><RateCell r={a.xirr} /></td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{pctPlain(a.actualYield)}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{pctPlain(a.forwardYield)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* per-holding */}
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["", "Ticker", "Since", "Money in", "Out + income", "Value", "Profit", "XIRR", "TWR (episode)", "Yield 12m", "Yield fwd"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i <= 2 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {[...openH, ...closedH].map((h) => (
              <tr key={h.wrapper + h.ticker} className={"hover:bg-[var(--panel2)]" + (h.open ? "" : " opacity-60")}>
                <td className="px-3 py-2"><WrapperChip wrapper={h.wrapper} /></td>
                <td className="px-3 py-2 font-medium">{h.ticker}{!h.open && <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--chip)] text-[var(--muted)] align-middle">closed</span>}</td>
                <td className="px-3 py-2 num text-[var(--muted)] whitespace-nowrap text-xs">{h.firstDate || "—"}</td>
                <td className="px-3 py-2 num text-right">{gbp(h.moneyIn)}</td>
                <td className="px-3 py-2 num text-right">{gbp(h.moneyOut + h.incomeReceived)}</td>
                <td className="px-3 py-2 num text-right">{h.open ? (h.priced ? gbp(h.marketValue) : "—") : gbp(0)}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (h.profit == null ? "text-[var(--muted)]" : h.profit >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{h.profit != null ? gbp(h.profit) : "—"}</td>
                <td className="px-3 py-2 text-right"><RateCell r={h.xirr} /></td>
                <td className="px-3 py-2 text-right">{h.twr.twr == null ? <span className="text-[var(--muted)]" title={h.twr.reason || ""}>—</span> : <span className={"num " + (h.twr.twr >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")} title={`Since ${h.twr.episodeStart} (${h.twr.spanDays}d)${h.twr.annualised != null && h.twr.spanDays >= SHORT_SPAN ? ` · ${pct(h.twr.annualised)} annualised` : ""}`}>{pct(h.twr.twr)}</span>}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{h.open ? pctPlain(h.income.actualYield) : "—"}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{h.open ? pctPlain(h.income.forwardYield) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        Everything here is pre-tax and in GBP. <span className="font-medium">XIRR</span> is your money-weighted annual return — cashflow-timing included — computed from every trade, cash distribution, and the current value (365-day count; † marks histories under {SHORT_SPAN} days, where annualised rates are noise). <span className="font-medium">TWR (episode)</span> is the cumulative time-weighted return on the current holding episode, exact from your own trade prices, with distributions treated as reinvested — compare it to a benchmark; compare XIRR to your own expectations. ERI counts toward income yields (it's real accumulation) but is never an XIRR cashflow (no cash moves). Cash balances sit outside all return figures. Forward yield applies the last 12 months' per-unit distributions to your current unit count — an estimate, not a promise.
      </p>
    </div>
  );
}

/* ---------------------------- Gilts tab ----------------------------- */
// Gilt ladder view (build step 4). Pure view over giltAnalytics()
// (core/gilts.mjs, DMO/HMRC-verified conventions).
/* --------------------------- Pension & LISA tab --------------------------- */
// Pension and LISA holdings are insurer/administrator-priced fund units, not
// exchange-traded — no live price feed exists for them (unlike everything
// else in the app), and they don't trade via buy/sell the way a normal
// ledger transaction does. This is a snapshot editor: each row is a current
// fund holding (units × price), not a transaction history. Editing a row
// replaces its underlying "opening balance" transaction(s) in one go, and
// LISA can either be itemised the same way or left as a single cash figure.
function PensionTab({ txns, setTxns, cash, setCash, secMeta, setSecMeta, prices, setPrices, pensionCashflows = [], setPensionCashflows }) {
  const [form, setForm] = useState({ wrapper: "SIPP", provider: "", ticker: "", name: "", units: "", price: "" });
  const [confirmRemoveProvider, setConfirmRemoveProvider] = useState(null);
  const [renaming, setRenaming] = useState(null); // provider name currently being renamed
  const [renameValue, setRenameValue] = useState("");
  const [expandedCf, setExpandedCf] = useState(null); // provider whose contribution history is expanded

  const rows = useMemo(() => {
    const byKey = {};
    for (const t of txns) {
      const w = normWrapper(t.wrapper);
      if (w !== "SIPP" && w !== "LISA") continue;
      const key = w + "\u0000" + t.ticker;
      const sign = t.side === "SELL" ? -1 : 1;
      (byKey[key] ||= { wrapper: w, ticker: t.ticker, units: 0, cost: 0 });
      byKey[key].units += sign * t.quantity;
      byKey[key].cost += sign * t.gbpAmount;
    }
    return Object.values(byKey).filter((r) => Math.abs(r.units) > 1e-9)
      .map((r) => ({ ...r, provider: secMeta[r.ticker]?.provider || "Unassigned" }))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.wrapper.localeCompare(b.wrapper) || a.ticker.localeCompare(b.ticker));
  }, [txns, secMeta]);

  const total = rows.reduce((s, r) => s + r.cost, 0) + (+cash.LISA || 0);
  const providers = useMemo(() => [...new Set(rows.map((r) => r.provider))].sort(), [rows]);
  const byProvider = useMemo(() => {
    const m = {};
    for (const r of rows) (m[r.provider] ||= []).push(r);
    return m;
  }, [rows]);
  const cashflowsByProvider = useMemo(() => {
    const m = {};
    for (const c of pensionCashflows) (m[c.provider] ||= []).push(c);
    return m;
  }, [pensionCashflows]);
  // Money-weighted return per provider: contributions are negative (money
  // out of pocket), current provider value is the one positive terminal
  // cashflow — same XIRR convention already used for GIA/ISA holdings.
  // Non-GBP contribution rows without a resolved GBP amount are excluded
  // (flagged separately) rather than guessed.
  const xirrByProvider = useMemo(() => {
    const out = {};
    for (const provider of providers) {
      const cfs = cashflowsByProvider[provider] || [];
      const usable = cfs.filter((c) => c.gbpAmount != null);
      const flows = usable.map((c) => ({ date: c.date, amount: -Math.abs(c.gbpAmount) }));
      // current MARKET VALUE (units × live price), not book cost — XIRR
      // compares money contributed against what it's worth now, not what
      // was paid in. Falls back to cost only if no price is set at all.
      const currentValue = byProvider[provider].reduce((s, r) => {
        const price = prices[r.ticker];
        return s + (price != null ? r.units * price : r.cost);
      }, 0);
      if (currentValue > 0) flows.push({ date: todayISO(), amount: currentValue });
      out[provider] = { result: xirr(flows), needsFx: cfs.length - usable.length, nCashflows: usable.length };
    }
    return out;
  }, [providers, cashflowsByProvider, byProvider, prices]);

  // Replace ALL transactions for (wrapper, ticker) with a single consolidated
  // snapshot row — this is a snapshot editor, not a running ledger, so an
  // edit here means "this is now the position", not "add another trade".
  const setRow = (wrapper, ticker, units, price) => {
    const value = round2(units * price);
    setTxns((all) => {
      const rest = all.filter((t) => !(normWrapper(t.wrapper) === wrapper && t.ticker === ticker));
      return [...rest, {
        id: `pension_${wrapper}_${ticker}_${Date.now()}`, date: todayISO(), ticker, side: "BUY",
        quantity: units, nativeCurrency: "GBP", nativeAmount: value, fxRate: 1, gbpAmount: value, wrapper,
        note: "Pension/LISA snapshot — edited via the Pension & LISA tab, cost = value at last edit (no contribution history tracked).",
      }];
    });
    setPrices((p) => ({ ...p, [ticker]: price }));
  };
  const removeRow = (wrapper, ticker) => setTxns((all) => all.filter((t) => !(normWrapper(t.wrapper) === wrapper && t.ticker === ticker)));

  const addRow = () => {
    const tk = form.ticker.toUpperCase().trim();
    const units = +form.units, price = +form.price;
    if (!tk || !Number.isFinite(units) || !Number.isFinite(price) || units <= 0) return;
    setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], name: form.name.trim() || tk, domicile: "GB", eri: false, kind: "fund", provider: form.provider.trim() || "Unassigned" } }));
    setRow(form.wrapper, tk, units, price);
    setForm({ ...form, ticker: "", name: "", units: "", price: "" });
  };

  // Removing a provider drops every holding tagged with it — for when a
  // pension is transferred/consolidated away entirely. Two-step (click to
  // arm, click again to confirm) rather than a browser confirm dialog.
  const removeProvider = (provider) => {
    if (confirmRemoveProvider !== provider) { setConfirmRemoveProvider(provider); return; }
    const tickers = (byProvider[provider] || []).map((r) => r.ticker);
    setTxns((all) => all.filter((t) => !(tickers.includes(t.ticker) && (normWrapper(t.wrapper) === "SIPP" || normWrapper(t.wrapper) === "LISA"))));
    setConfirmRemoveProvider(null);
  };
  const renameProvider = (oldName) => {
    const next = renameValue.trim();
    if (!next || next === oldName) { setRenaming(null); return; }
    setSecMeta((m) => {
      const copy = { ...m };
      for (const tk of Object.keys(copy)) if ((copy[tk].provider || "Unassigned") === oldName) copy[tk] = { ...copy[tk], provider: next };
      return copy;
    });
    setRenaming(null);
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Stat label="Pension & LISA total" value={gbp(total)} big />
        <Stat label="SIPP" value={gbp(rows.filter((r) => r.wrapper === "SIPP").reduce((s, r) => s + r.cost, 0))} />
        <Stat label="LISA" value={gbp(rows.filter((r) => r.wrapper === "LISA").reduce((s, r) => s + r.cost, 0) + (+cash.LISA || 0))} />
      </div>

      {rows.length === 0 && !(+cash.LISA) ? (
        <Empty msg="No pension or LISA holdings yet. Add a fund below, or set a LISA cash total if you don't want to itemise by fund." />
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => {
            const providerRows = byProvider[provider];
            const providerTotal = providerRows.reduce((s, r) => s + r.cost, 0);
            const xr = xirrByProvider[provider];
            const cfs = (cashflowsByProvider[provider] || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));
            const showingCf = expandedCf === provider;
            return (
              <div key={provider} className="rounded-xl border border-[var(--border)] overflow-hidden">
                <div className="flex items-center justify-between px-3 py-2 bg-[var(--panel2)]">
                  {renaming === provider ? (
                    <div className="flex items-center gap-1.5">
                      <input autoFocus value={renameValue} onChange={(e) => setRenameValue(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && renameProvider(provider)}
                        className="input py-1 text-sm w-48" />
                      <button onClick={() => renameProvider(provider)} className="text-[var(--accent)] text-xs font-medium">Save</button>
                      <button onClick={() => setRenaming(null)} className="text-[var(--muted)] text-xs">Cancel</button>
                    </div>
                  ) : (
                    <button onClick={() => { setRenaming(provider); setRenameValue(provider); }} className="text-sm font-medium hover:underline decoration-dotted">{provider}</button>
                  )}
                  <div className="flex items-center gap-3">
                    {xr && xr.result.rate != null && (
                      <span className={"text-xs font-medium num " + (xr.result.rate >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")} title={`Money-weighted return (XIRR) from ${xr.nCashflows} contribution${xr.nCashflows === 1 ? "" : "s"}${xr.needsFx ? `; ${xr.needsFx} non-GBP row(s) need FX, excluded` : ""}`}>
                        XIRR {(xr.result.rate * 100).toFixed(1)}%
                      </span>
                    )}
                    {cfs.length > 0 && (
                      <button onClick={() => setExpandedCf(showingCf ? null : provider)} className="text-xs text-[var(--muted)] hover:text-[var(--fg)]">
                        {cfs.length} contribution{cfs.length === 1 ? "" : "s"} {showingCf ? "▲" : "▼"}
                      </button>
                    )}
                    <span className="num text-sm font-medium">{gbp(providerTotal)}</span>
                    <button onClick={() => removeProvider(provider)}
                      className={"text-xs px-2 py-1 rounded " + (confirmRemoveProvider === provider ? "bg-[var(--loss)] text-white" : "text-[var(--muted)] hover:text-[var(--loss)]")}>
                      {confirmRemoveProvider === provider ? "Click again to remove all holdings" : "Remove provider"}
                    </button>
                  </div>
                </div>
                <table className="w-full text-sm">
                  <thead className="text-[var(--muted)] text-xs uppercase tracking-wide">
                    <tr>{["Wrapper", "Fund", "Units", "Price", "Value", ""].map((h, i) => <th key={i} className={"px-3 py-1.5 font-medium " + (i >= 2 && i <= 4 ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                    {providerRows.map((r) => {
                      const name = secMeta[r.ticker]?.name || r.ticker;
                      const price = r.units ? r.cost / r.units : 0;
                      return (
                        <tr key={r.wrapper + r.ticker}>
                          <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                          <td className="px-3 py-2">
                            <div className="font-medium">{r.ticker}</div>
                            <div className="text-xs text-[var(--muted)]">{name}</div>
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input type="number" defaultValue={round2(r.units)} onBlur={(e) => setRow(r.wrapper, r.ticker, +e.target.value || 0, price)} className="input num w-28 text-right py-1" />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <input type="number" defaultValue={round2(price)} onBlur={(e) => setRow(r.wrapper, r.ticker, r.units, +e.target.value || 0)} className="input num w-24 text-right py-1" />
                          </td>
                          <td className="px-3 py-2 text-right num font-medium">{gbp(r.cost)}</td>
                          <td className="px-3 py-2 text-right"><button onClick={() => removeRow(r.wrapper, r.ticker)} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} /></button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {showingCf && (
                  <div className="border-t border-[var(--border)] max-h-64 overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead className="text-[var(--muted)] sticky top-0 bg-[var(--panel)]"><tr>{["Date", "Type", "Amount", ""].map((h, i) => <th key={i} className={"px-3 py-1 font-medium " + (i === 2 ? "text-right" : "text-left")}>{h}</th>)}</tr></thead>
                      <tbody className="divide-y divide-[var(--border)]">
                        {cfs.map((c) => (
                          <tr key={c.id}>
                            <td className="px-3 py-1 num">{c.date}</td>
                            <td className="px-3 py-1">{c.type}</td>
                            <td className="px-3 py-1 text-right num">{c.gbpAmount != null ? gbp(c.gbpAmount) : <span className="text-[var(--m-bb)]" title="Non-GBP, no FX resolved — excluded from XIRR">{c.nativeAmount} {c.ccy} (needs FX)</span>}</td>
                            <td className="px-3 py-1 text-right"><button onClick={() => setPensionCashflows((p) => p.filter((x) => x.id !== c.id))} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={12} /></button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="Wrapper"><select value={form.wrapper} onChange={(e) => setForm({ ...form, wrapper: e.target.value })} className="input">{["SIPP", "LISA"].map((w) => <option key={w}>{w}</option>)}</select></Field>
        <Field label="Provider (existing or new)">
          <input list="pension-providers" value={form.provider} onChange={(e) => setForm({ ...form, provider: e.target.value })} className="input w-44" placeholder="e.g. L&G (Citi)" />
          <datalist id="pension-providers">{providers.map((p) => <option key={p} value={p} />)}</datalist>
        </Field>
        <Field label="Ticker / code"><input value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value.toUpperCase() })} className="input num w-28" placeholder="e.g. CITIUS" /></Field>
        <Field label="Fund name"><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="input w-56" placeholder="e.g. L&G Global Equity" /></Field>
        <Field label="Units"><input type="number" value={form.units} onChange={(e) => setForm({ ...form, units: e.target.value })} className="input num w-28" placeholder="0" /></Field>
        <Field label="Price / unit (£)"><input type="number" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} className="input num w-28" placeholder="0.00" /></Field>
        <button onClick={addRow} className="btn-accent"><Plus size={15} /> Add fund</button>
      </div>

      <div className="flex items-end gap-3 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="LISA cash / unallocated (£)"><CurrencyInput value={cash.LISA || 0} onChange={(v) => setCash((c) => ({ ...c, LISA: v }))} className="w-40" /></Field>
        <p className="text-xs text-[var(--muted)] pb-2 max-w-md">Use this if you'd rather track LISA as a single total than itemise it fund-by-fund above.</p>
      </div>

      <p className="text-xs text-[var(--muted)]">
        Holdings are grouped by provider — click a provider's name to rename it (e.g. when a scheme moves administrator), or "Remove provider" to drop every holding under it in one go (for a full transfer/consolidation elsewhere). New funds pick up whichever provider you type or select.
        Editing units or price replaces the position outright (this is a snapshot, not a running ledger) — cost basis resets to the new value, since contribution history usually isn't available for insurer-administered pensions.
        SIPP and LISA are both tax-sheltered, so nothing here affects any CGT or income-tax figure elsewhere in the app; it only feeds your total wealth.
      </p>
    </div>
  );
}


function GiltsTab({ data, secMeta, setSecMeta, prices, setPrices }) {
  const [form, setForm] = React.useState({ ticker: "", name: "", coupon: "", maturity: "", isin: "" });
  const [dmoState, setDmoState] = React.useState({ status: "idle", message: "" }); // idle | loading | done | error
  const registered = Object.entries(secMeta).filter(([, m]) => m && m.kind === "gilt");
  const registerGilt = () => {
    const tk = form.ticker.toUpperCase().trim();
    if (!tk || !Number.isFinite(+form.coupon) || !/^\d{4}-\d{2}-\d{2}$/.test(form.maturity)) return;
    setSecMeta((m) => ({
      ...m,
      [tk]: { ...m[tk], kind: "gilt", coupon: +form.coupon, maturity: form.maturity, domicile: "GB", eri: false,
        name: form.name.trim() || tk, isin: form.isin.toUpperCase().trim() || (m[tk] && m[tk].isin) || "" },
    }));
    setForm({ ticker: "", name: "", coupon: "", maturity: "", isin: "" });
  };

  // Live gilt prices from the DMO's own official daily Purchase & Sale Service
  // prices (see api/gilt-prices.mjs) — neither Alpha Vantage nor Yahoo Finance
  // covers individual gilts by ISIN, verified by hand before building this.
  const fetchDmoPrices = async () => {
    const targets = registered.map(([tk, m]) => ({ ticker: tk, isin: m.isin }));
    if (!targets.some((t) => t.isin)) { setDmoState({ status: "error", message: "No registered gilt has an ISIN to look up." }); return; }
    setDmoState({ status: "loading", message: "" });
    try {
      const { pricesByTicker, matched, date, total } = await fetchDmoGiltPrices(targets);
      setPrices((pr) => ({ ...pr, ...pricesByTicker }));
      setDmoState({
        status: "done",
        message: matched
          ? `Updated ${matched}/${total} gilt${total === 1 ? "" : "s"} from the DMO report dated ${date}.`
          : `DMO report dated ${date} didn't include any of your registered ISINs.`,
      });
    } catch (e) {
      setDmoState({ status: "error", message: e.message || "Fetch failed." });
    }
  };

  if (!data) return <Empty msg="Couldn't compute gilt analytics — check the Transactions tab for ledger errors." />;
  const live = data.holdings.filter((h) => h.nominal > 1e-9);
  const aisYears = Object.keys(data.ais.byYear).sort();
  const upcoming = data.cashflows.slice(0, 12);

  return (
    <div className="space-y-4">
      {live.length === 0 && (
        <Empty msg={`No gilt holdings yet. Buy an individual gilt in any wrapper using a registered ticker (${registered.map(([t]) => t).join(", ") || "none registered"}) on the Transactions tab, or register another gilt below. Quantity = £ nominal (face value); price = clean price per £1 nominal (e.g. £94.23 per £100 → 0.9423 — the live price feed for LSE gilt lines already lands in this unit).`} />
      )}

      {live.length > 0 && (
        <>
          {/* DMO live price fetch */}
          <div className="flex items-center gap-3 flex-wrap">
            <button className="btn-accent" onClick={fetchDmoPrices} disabled={dmoState.status === "loading"}>
              <Landmark size={15} /> {dmoState.status === "loading" ? "Fetching…" : "Fetch DMO gilt prices"}
            </button>
            {dmoState.status === "done" && <span className="text-sm text-[var(--gain)]">{dmoState.message}</span>}
            {dmoState.status === "error" && <span className="text-sm text-[var(--loss)]">{dmoState.message}</span>}
            <span className="text-xs text-[var(--muted)]">Official DMO daily clean prices (midpoint of their published purchase/sale quotes) — not Alpha Vantage or Yahoo, neither covers individual gilts.</span>
          </div>

          {/* headline */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Gilt ladder (dirty value)" value={live.every((h) => h.dirtyValue != null) ? gbp(live.reduce((s, h) => s + h.dirtyValue, 0)) : "—"} sub={`${live.length} holding${live.length === 1 ? "" : "s"}; par at maturity ${gbp(live.reduce((s, h) => s + h.nominal, 0))}`} big />
            <Stat label="of which accrued interest" value={gbp(live.reduce((s, h) => s + h.accruedValue, 0))} sub="actual/actual, to today" />
            <Stat label="Coupon income next 12m" value={gbp(live.reduce((s, h) => s + h.couponIncomeNext12m, 0))} sub="taxable as interest where unsheltered" />
            <Stat label="Next cashflow" value={upcoming[0] ? gbp(upcoming[0].amount) : "—"} sub={upcoming[0] ? `${upcoming[0].ticker} ${upcoming[0].type} · ${upcoming[0].date}` : undefined} />
          </div>

          {/* ladder */}
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Gilt", "Wrapper", "Maturity", "Nominal", "Clean /£100", "Accrued /£100", "Dirty value", "Next coupon", "GRY (semi)", "12m coupons"].map((h, i) => (
                  <th key={i} className={"px-3 py-2 font-medium " + (i <= 2 ? "text-left" : "text-right")}>{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {live.map((h) => (
                  <tr key={h.wrapper + h.ticker} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2 font-medium" title={`${h.name} · ${h.isin}`}>
                      {h.ticker}
                      {h.exDiv && <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle" title="In the ex-dividend window (7 business days before the coupon; bank holidays not modelled) — accrued is negative (rebate); the registered holder at ex-div gets the coupon">ex-div</span>}
                    </td>
                    <td className="px-3 py-2"><WrapperChip wrapper={h.wrapper} /></td>
                    <td className="px-3 py-2 num text-[var(--muted)] whitespace-nowrap text-xs">{h.maturity}</td>
                    <td className="px-3 py-2 num text-right">{gbp(h.nominal)}</td>
                    <td className="px-3 py-2 text-right">
                      <input type="number" step="0.0001" value={prices[h.ticker] != null ? +(prices[h.ticker] * 100).toFixed(4) : ""} placeholder="—"
                        onChange={(e) => setPrices((pr) => ({ ...pr, [h.ticker]: e.target.value === "" ? undefined : +e.target.value / 100 }))}
                        className="input num w-24 text-right py-1" title="Clean price per £100 nominal (stored per £1 for consistency with the rest of the app)" />
                    </td>
                    <td className={"px-3 py-2 num text-right " + (h.accruedPer100 < 0 ? "text-[var(--m-bb)]" : "text-[var(--muted)]")}>{num(h.accruedPer100, 4)}</td>
                    <td className="px-3 py-2 num text-right">{h.dirtyValue != null ? gbp(h.dirtyValue) : "—"}</td>
                    <td className="px-3 py-2 num text-right whitespace-nowrap">{h.nextCoupon ? <span className="text-xs">{gbp(h.nextCoupon.amount)} <span className="text-[var(--muted)]">on {h.nextCoupon.date}</span></span> : "—"}</td>
                    <td className="px-3 py-2 num text-right">{h.gry && h.gry.semiAnnual != null ? <span title={`Effective annual ${num(h.gry.effectiveAnnual * 100, 3)}% · dirty ${num(h.gry.dirty, 4)}/£100`}>{num(h.gry.semiAnnual * 100, 2)}%</span> : "—"}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(h.couponIncomeNext12m)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* coupon calendar */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="text-sm font-medium flex items-center gap-2 mb-2"><Landmark size={15} className="text-[var(--accent)]" /> Upcoming cashflows <span className="text-xs font-normal text-[var(--muted)]">— next {upcoming.length} of {data.cashflows.length} to final maturity</span></div>
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1">
              {upcoming.map((f, i) => (
                <div key={i} className="flex items-baseline justify-between text-sm border-b border-[var(--border)] last:border-0 py-1">
                  <span className="num text-[var(--muted)]">{f.date}</span>
                  <span className="font-medium">{f.ticker}<span className={"ml-1.5 text-[10px] px-1 py-0.5 rounded " + (f.type === "redemption" ? "bg-[color:color-mix(in_srgb,var(--accent)_18%,transparent)] text-[var(--accent)]" : "bg-[var(--chip)] text-[var(--muted)]")}>{f.type}</span></span>
                  <span className="num">{gbp(f.amount)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* AIS */}
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
            <div className="text-sm font-medium">Accrued Income Scheme (GIA trades only)</div>
            {aisYears.length === 0 ? (
              <p className="text-xs text-[var(--muted)]">No GIA gilt transfers — nothing to adjust.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-[var(--muted)] text-xs uppercase tracking-wide">
                  <tr><th className="text-left py-1 font-medium">Tax year of next coupon</th><th className="text-right font-medium">Transfers</th><th className="text-right font-medium">Net adjustment to taxable interest</th></tr>
                </thead>
                <tbody>
                  {aisYears.map((y) => (
                    <tr key={y} className="border-t border-[var(--border)]">
                      <td className="py-1.5 num">{y}</td>
                      <td className="py-1.5 num text-right text-[var(--muted)]">{data.ais.byYear[y].items.length}</td>
                      <td className={"py-1.5 num text-right font-medium " + (data.ais.byYear[y].net >= 0 ? "text-[var(--loss)]" : "text-[var(--gain)]")}>{data.ais.byYear[y].net >= 0 ? "+" : "−"}{gbp(Math.abs(data.ais.byYear[y].net)).slice(1)} {data.ais.byYear[y].net >= 0 ? "profit" : "relief"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-xs text-[var(--muted)] leading-relaxed">
              Estimates from trade dates (gilts settle T+1, so a trade near a coupon or the ex-div boundary can shift a day's accrual or flip cum/ex — check contract notes). Adjustments are taxed in the tax year the <em>next coupon</em> falls, pooled across all your AIS securities. {data.ais.smallHoldingsLikelyExcluded ? "Your peak GIA gilt nominal is within the £5,000 small-holdings limit, so the scheme likely doesn't apply to you at all — figures shown for completeness." : "The £5,000 small-holdings exclusion doesn't apply to you (peak GIA nominal " + gbp(data.ais.maxNominalGIA) + "), so these adjustments belong on your return alongside the coupons themselves."} These figures are not yet folded into the Income tab's tax computation — they're the disclosure-ready numbers for boxes on the Ai pages.
            </p>
          </div>
        </>
      )}

      {/* register */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
        <div className="text-sm font-medium">Register a gilt</div>
        <div className="flex flex-wrap gap-2">
          <input className="input w-24" placeholder="Ticker" value={form.ticker} onChange={(e) => setForm({ ...form, ticker: e.target.value })} />
          <input className="input flex-1 min-w-40" placeholder="Name (optional)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <input className="input w-28" type="number" step="0.001" placeholder="Coupon %" value={form.coupon} onChange={(e) => setForm({ ...form, coupon: e.target.value })} />
          <input className="input w-40" type="date" title="Maturity date" value={form.maturity} onChange={(e) => setForm({ ...form, maturity: e.target.value })} />
          <input className="input w-40" placeholder="ISIN (optional)" value={form.isin} onChange={(e) => setForm({ ...form, isin: e.target.value })} />
          <button className="btn-accent" onClick={registerGilt}>Add</button>
        </div>
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Registered: {registered.length ? registered.map(([t, m]) => `${t} (${m.coupon}% ${m.maturity})`).join(" · ") : "none"}. Registering marks the ticker CGT-exempt (TCGA 1992 s115) and interest-paying, and drives the coupon schedule — coupon and maturity must come from the DMO/your broker, not memory. Conventions: semi-annual coupons anchored at maturity, actual/actual accrued, ex-div 7 business days (weekends only — UK bank holidays not modelled). Index-linked gilts are NOT supported: schedules here assume fixed cash coupons and par redemption, so an IL gilt's figures would be wrong — leave those unregistered.
        </p>
      </div>
    </div>
  );
}

/* --------------------------- Holdings tab --------------------------- */
function HoldingsTab({ positions, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta }) {
  const open = positions.filter((p) => p.qty > 1e-6);
  if (!open.length) return <Empty msg="No open holdings yet. Add buy transactions (any wrapper) to see your positions and unrealised gains." />;

  const setISIN = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], isin: v.toUpperCase().trim() } }));

  const rows = open.map((p) => {
    const cost = p.bookCost;
    const avg = p.qty ? cost / p.qty : 0;
    const price = prices[p.ticker] ?? "";
    const hasP = price !== "" && !isNaN(+price);
    const value = hasP ? p.qty * +price : null;
    const unreal = hasP ? value - cost : null;
    return { tk: p.ticker, wrapper: p.wrapper, qty: p.qty, cost, avg, price, value, unreal,
      pct: hasP && cost ? (unreal / cost) * 100 : null, sec: secMeta[p.ticker] || {},
      sheltered: !isWrapperTaxable(p.wrapper) };
  }).sort((a, b) => a.wrapper.localeCompare(b.wrapper) || a.tk.localeCompare(b.tk));

  const priced = rows.filter((r) => r.value != null);
  const totCost = priced.reduce((s, r) => s + r.cost, 0);
  const totValue = priced.reduce((s, r) => s + r.value, 0);
  const totUnreal = totValue - totCost;
  const missingIsin = rows.filter((r) => !r.sec.isin).length;
  const tickers = [...new Set(rows.map((r) => r.tk))];
  // Taxable vs sheltered split of pool cost, so the all-wrapper view still
  // makes the CGT-relevant portion obvious at a glance.
  const taxableCost = rows.filter((r) => !r.sheltered).reduce((s, r) => s + r.cost, 0);
  const shelteredCost = rows.filter((r) => r.sheltered).reduce((s, r) => s + r.cost, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Open pool cost" value={gbp(rows.reduce((s, r) => s + r.cost, 0))} sub={`taxable ${gbp(taxableCost)} · sheltered ${gbp(shelteredCost)}`} />
        <Stat label="Market value (priced)" value={priced.length ? gbp(totValue) : "—"} sub={priced.length < rows.length ? `${priced.length}/${rows.length} priced` : "all priced"} />
        <Stat label="Unrealised gain" value={priced.length ? gbp(totUnreal) : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} big />
        <Stat label="Unrealised %" value={priced.length && totCost ? `${totUnreal >= 0 ? "+" : ""}${num((totUnreal / totCost) * 100)}%` : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} />
      </div>

      <LivePricesPanel {...{ tickers, avKey, setAvKey, avMeta, setAvMeta, prices, setPrices, priceMeta, setPriceMeta, txns, secMeta }} />

      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Ticker", "ISIN", "Quantity", "Avg cost", "Pool cost", "Price now", "Market value", "Unrealised", "%"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i <= 2 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {rows.map((r) => (
              <tr key={r.wrapper + r.tk} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                <td className="px-3 py-2 font-medium">
                  {r.tk}
                  {r.sec.eri === true && <span title="Offshore reporting fund — generates excess reportable income (ERI) while held unsheltered" className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle">ERI</span>}
                </td>
                <td className="px-3 py-2">
                  <input value={r.sec.isin || ""} onChange={(e) => setISIN(r.tk, e.target.value)} placeholder="IE00…" className="input font-mono text-xs w-36 py-1" />
                </td>
                <td className="px-3 py-2 num text-right">{num(r.qty, r.qty % 1 ? 2 : 0)}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.avg)}</td>
                <td className="px-3 py-2 num text-right">{gbp(r.cost)}</td>
                <td className="px-3 py-2 text-right">
                  <input type="number" value={r.price} placeholder="—"
                    onChange={(e) => setPrices((p) => ({ ...p, [r.tk]: e.target.value === "" ? undefined : +e.target.value }))}
                    className="input num w-24 text-right py-1" />
                </td>
                <td className="px-3 py-2 num text-right">{r.value != null ? gbp(r.value) : "—"}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.unreal != null ? gbp(r.unreal) : "—"}</td>
                <td className={"px-3 py-2 num text-right " + (r.pct == null ? "text-[var(--muted)]" : r.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.pct != null ? `${r.pct >= 0 ? "+" : ""}${num(r.pct)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">
        All holdings across every wrapper (GIA, ISA, SIPP, LISA, VCT). The same price per share applies to a ticker wherever it's held. Prices save locally on your device.
        Unrealised gain = current value − Section 104 pool cost; it's an indicator, not a taxable event. Only <span className="font-semibold">GIA</span> holdings are subject to CGT — ISA/SIPP/LISA/VCT are sheltered.
        {missingIsin > 0 && ` ISIN is set for ${rows.length - missingIsin}/${rows.length} rows — it's the join key for matching issuer ERI reports, so fill in the rest when you get the chance.`}
        {" "}The <span className="text-[var(--m-bb)] font-semibold">ERI</span> badge flags offshore reporting funds.
      </p>
    </div>
  );
}

/* --------------------------- Planning tab --------------------------- */
// Shared scope banner for the three CGT-specific tools (Planning, Report,
// What-if). These are deliberately GIA-only: they compute UK Capital Gains
// Tax, which only applies to unsheltered holdings. ISA/SIPP/LISA/VCT are
// exempt, so including them here would be misleading, not helpful.
function CgtScopeBanner({ tool }) {
  const msg = {
    planning: "This is a CGT tool — it shows GIA holdings only, since ISA, SIPP, LISA and VCT gains aren't taxable. For your full portfolio, see the Wealth and Holdings tabs.",
    report: "CGT report for GIA holdings only. ISA/SIPP/LISA/VCT disposals are CGT-exempt and deliberately excluded (individual gilts too, under TCGA 1992 s115).",
    whatif: "Models the CGT impact of a sale — GIA holdings only, since selling inside ISA/SIPP/LISA/VCT triggers no CGT.",
  }[tool];
  return (
    <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel2)] text-[var(--muted)]">
      <Info size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
      <span>{msg}</span>
    </div>
  );
}

function PlanningTab({ pools, prices, setPrices, disposals, txns, income }) {
  const yearNow = ukTaxYear(todayISO());
  const aea = aeaForYear(yearNow);
  const realised = disposals.filter((d) => d.taxYear === yearNow);
  const realisedNet = realised.reduce((s, d) => s + d.gain, 0);
  const headroom = Math.max(0, aea - realisedNet); // gains realisable tax-free this year
  const tickers = Object.keys(pools).filter((t) => pools[t].qty > 1e-6).sort();

  // 30-day forward warning: buys of the same ticker within the last 30 days.
  const today = new Date(todayISO());
  const recentBuys = {};
  for (const t of txns) {
    if (t.side !== "BUY") continue;
    const days = (today - new Date(t.date)) / 86400000;
    if (days >= 0 && days <= 30) recentBuys[t.ticker] = (recentBuys[t.ticker] || 0) + (+t.quantity);
  }
  // past disposals that were matched under the 30-day rule
  const pastBB = disposals.filter((d) => d.legs.some((l) => l.method === "THIRTY_DAY"));

  const rows = tickers.map((tk) => {
    const { qty, cost } = pools[tk];
    const avg = qty ? cost / qty : 0;
    const price = prices[tk];
    const hasP = price != null && price !== "" && !isNaN(+price);
    const perShare = hasP ? +price - avg : null;
    const maxShares = hasP && perShare > 0 ? Math.min(qty, Math.floor(headroom / perShare)) : null;
    const gainIf = maxShares != null ? maxShares * perShare : null;
    const unreal = hasP ? qty * +price - cost : null;
    return { tk, qty, avg, price: hasP ? price : "", perShare, maxShares, gainIf, unreal, recentBuy: recentBuys[tk] };
  });

  return (
    <div className="space-y-5">
      <CgtScopeBanner tool="planning" />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label={`AEA ${yearNow}`} value={gbp(aea).replace(".00", "")} />
        <Stat label="Net gains realised" value={gbp(realisedNet)} tone={realisedNet >= 0 ? "gain" : "loss"} />
        <Stat label="Tax-free headroom left" value={gbp(headroom)} tone="gain" big sub={realisedNet < 0 ? "AEA + realised losses" : "AEA − gains used"} />
        <Stat label="Holdings priced" value={`${rows.filter((r) => r.price !== "").length}/${rows.length}`} />
      </div>

      <div>
        <h3 className="text-sm font-semibold mb-2">Harvesting — sell within this year's allowance</h3>
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
              <tr>{["Ticker", "Avg cost", "Price now", "Gain / share", "Unrealised", "Max shares tax-free", "Gain realised"].map((h, i) => (
                <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
              ))}</tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
              {rows.map((r) => (
                <tr key={r.tk} className="hover:bg-[var(--panel2)]">
                  <td className="px-3 py-2 font-medium">{r.tk}{r.recentBuy ? <AlertCircle size={13} className="inline ml-1 -mt-0.5 text-[var(--m-bb)]" /> : null}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.avg)}</td>
                  <td className="px-3 py-2 text-right">
                    <input type="number" value={r.price} placeholder="—"
                      onChange={(e) => setPrices((p) => ({ ...p, [r.tk]: e.target.value === "" ? undefined : +e.target.value }))}
                      className="input num w-24 text-right py-1" />
                  </td>
                  <td className={"px-3 py-2 num text-right " + (r.perShare == null ? "text-[var(--muted)]" : r.perShare >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.perShare != null ? gbp(r.perShare) : "—"}</td>
                  <td className={"px-3 py-2 num text-right " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.unreal != null ? gbp(r.unreal) : "—"}</td>
                  <td className="px-3 py-2 num text-right font-medium">{r.maxShares != null ? num(r.maxShares, 0) : (r.price === "" ? "—" : "no gain")}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{r.gainIf != null ? gbp(r.gainIf) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-[var(--muted)] mt-2">
          "Max shares tax-free" assumes the whole remaining allowance is used on that one holding — the {gbp(headroom).replace(".00", "")} headroom is shared, so you can't stack it across several. Figures assume a clean sale with no repurchase within 30 days.
        </p>
      </div>

      {(Object.keys(recentBuys).length > 0 || pastBB.length > 0) && (
        <div className="rounded-xl border p-4 space-y-2"
          style={{ background: "color-mix(in srgb, var(--m-bb) 10%, transparent)", borderColor: "color-mix(in srgb, var(--m-bb) 35%, transparent)" }}>
          <h3 className="text-sm font-semibold flex items-center gap-2" style={{ color: "var(--m-bb)" }}><AlertCircle size={15} /> 30-day (bed &amp; breakfast) rule</h3>
          {Object.keys(recentBuys).length > 0 && (
            <div className="text-sm text-[var(--fg)]">
              You've bought within the last 30 days: {Object.entries(recentBuys).map(([t, q]) => `${num(q, q % 1 ? 2 : 0)} ${t}`).join(", ")}. A sale of the same holding now is matched to that purchase first — not your Section 104 pool — so it won't crystallise the pool gain you might be expecting.
            </div>
          )}
          {pastBB.length > 0 && (
            <div className="text-sm text-[var(--fg)]">
              Past disposals already matched under the 30-day rule: {pastBB.map((d) => `${d.ticker} ${d.date}`).join(", ")}.
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-[var(--muted)]">
        The 30-day rule matches a disposal against any repurchase of the same security in the following 30 days before it touches the pool. To crystallise a pool gain (e.g. to use your allowance), avoid rebuying the same line within 30 days — buy a similar-but-not-identical fund, or repurchase inside an ISA/pension instead.
      </p>

      <MultiYearOptimiser pools={pools} prices={prices} income={income} />
    </div>
  );
}

/* Multi-year gain-harvesting: stagger disposals to soak up each year's AEA
   (and optionally basic-band room) and show how long an embedded gain takes to wash. */
function MultiYearOptimiser({ pools, prices, income }) {
  const yearNow = ukTaxYear(todayISO());
  const [startYear, setStartYear] = useState(yearNow);
  const [years, setYears] = useState(10);
  const [useBasicBand, setUseBasicBand] = useState(false);
  const [growth, setGrowth] = useState(0);

  const startOpts = useMemo(() => { const a = []; let y = yearNow; for (let i = 0; i < 4; i++) { a.push(y); y = nextTaxYear(y); } return a; }, [yearNow]);
  const holdings = useMemo(() => Object.keys(pools).filter((t) => pools[t].qty > 1e-6).map((t) => {
    const { qty, cost } = pools[t]; const p = prices[t];
    return { ticker: t, qty, cost, price: (p != null && p !== "" && !isNaN(+p)) ? +p : NaN };
  }).filter((h) => isFinite(h.price) && h.price > 0), [pools, prices]);

  const result = useMemo(() => {
    if (!holdings.length) return null;
    try { return optimiseDisposals({ holdings, startYear, years: Math.max(1, Math.min(40, +years || 1)), income: +income || 0, useBasicBand, growth: (+growth || 0) / 100 }); }
    catch { return null; }
  }, [holdings, startYear, years, income, useBasicBand, growth]);

  const priced = holdings.length;
  const totalTax = result ? result.schedule.reduce((s, r) => s + r.tax, 0) : 0;

  return (
    <div className="space-y-3 pt-2">
      <h3 className="text-sm font-semibold flex items-center gap-2"><Wand2 size={15} /> Multi-year disposal optimiser</h3>
      <p className="text-xs text-[var(--muted)]">
        Staggers sales across tax years to harvest gains up to each year's annual exempt amount (tax-free){useBasicBand ? ", plus basic-rate band room at 18%," : ""} then resets base cost by rebuying at market (bed-&amp;-ISA or bed-&amp;-spouse to sidestep the 30-day rule). Uses your {priced} priced GIA holding{priced === 1 ? "" : "s"}.
      </p>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
          <Field label="Start tax year"><select value={startYear} onChange={(e) => setStartYear(e.target.value)} className="input w-full">{startOpts.map((y) => <option key={y}>{y}</option>)}</select></Field>
          <Field label="Horizon (years)"><input type="number" min="1" max="40" value={years} onChange={(e) => setYears(e.target.value)} className="input num w-full" /></Field>
          <Field label="Assumed growth %/yr"><input type="number" step="0.5" value={growth} onChange={(e) => setGrowth(e.target.value)} className="input num w-full" /></Field>
          <label className="flex items-center gap-2 text-sm cursor-pointer pb-2"><input type="checkbox" checked={useBasicBand} onChange={(e) => setUseBasicBand(e.target.checked)} className="accent-[var(--accent)]" /> Use basic-rate band (18%)</label>
        </div>
      </div>

      {!priced && <Empty msg="Set current prices on the holdings above (or the Holdings tab) to run the optimiser." />}

      {result && priced > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Embedded gain now" value={gbp(result.startEmbedded)} tone={result.startEmbedded >= 0 ? "gain" : "loss"} />
            <Stat label={useBasicBand ? "Gain washed over horizon" : "Gain washed tax-free"} value={gbp(result.totalWashed)} big tone="gain" />
            <Stat label="Years to clear" value={result.yearsToClear ? `${result.yearsToClear}` : `>${years}`} sub={result.yearsToClear ? "" : "still embedded gain left"} />
            <Stat label="Tax over plan" value={gbp(totalTax)} tone={totalTax > 0 ? "loss" : undefined} sub={useBasicBand ? "basic-band 18%" : "within AEA"} />
          </div>

          <div className="rounded-xl border border-[var(--border)] overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Tax year", "Harvest", "AEA used", "Tax", "Sell", "Cumulative washed", "Gain still embedded"].map((h, i) => (
                  <th key={i} className={"px-3 py-2 font-medium " + (i === 0 || i === 4 ? "text-left" : "text-right")}>{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {result.schedule.map((r) => (
                  <tr key={r.year} className="hover:bg-[var(--panel2)]">
                    <td className="px-3 py-2 num font-medium">{r.year}</td>
                    <td className="px-3 py-2 num text-right">{gbp(r.gainRealised)}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.aeaUsed).replace(".00", "")}</td>
                    <td className={"px-3 py-2 num text-right " + (r.tax > 0 ? "text-[var(--loss)]" : "text-[var(--muted)]")}>{r.tax > 0 ? gbp(r.tax) : "—"}</td>
                    <td className="px-3 py-2 text-[var(--muted)] text-xs">{r.sells.map((s) => `${num(s.shares, s.shares % 1 ? 2 : 0)} ${s.ticker}`).join(", ") || "—"}</td>
                    <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.cumulativeWashed)}</td>
                    <td className="px-3 py-2 num text-right">{gbp(r.remainingUnrealised)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-[var(--muted)]">
            Each year's harvest sells the highest gain-per-share holdings first and assumes you rebuy at the same price to reset base cost. Growth compounds the price of unsold shares. This models the CGT wash only — dealing costs, spreads and stamp duty on rebuys aren't included, and a bed-&amp;-ISA rebuy also consumes ISA allowance.
          </p>
        </>
      )}
    </div>
  );
}

/* ---------------------------- Report tab ---------------------------- */
function ReportTab({ taxYears, disposals, income, carried }) {
  const [ry, setRy] = useState(taxYears[0] || "2025/26");
  const [msg, setMsg] = useState("");
  const yr = taxYears.includes(ry) ? ry : (taxYears[0] || "2025/26");
  const yd = disposals.filter((d) => d.taxYear === yr);
  const liab = liabilityForYear(yd, { income, carriedLosses: carried });
  const totalCost = yd.reduce((s, d) => s + d.cost, 0);
  const flash = (m) => { setMsg(m); setTimeout(() => setMsg(""), 3500); };

  const csvCell = (v) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const exportCSV = async () => {
    const rows = [["Tax year", "Disposal date", "Security", "Matching method", "Quantity", "Proceeds GBP", "Allowable cost GBP", "Gain/loss GBP"]];
    for (const d of yd) for (const l of d.legs) rows.push([yr, d.date, d.ticker, METHOD[l.method].label, l.quantity, l.proceeds.toFixed(2), l.cost.toFixed(2), l.gain.toFixed(2)]);
    rows.push([], ["Summary (SA108 Capital Gains — listed shares & securities)"]);
    rows.push(["Number of disposals", yd.length]);
    rows.push(["Disposal proceeds (box 24)", liab.proceeds.toFixed(2)]);
    rows.push(["Allowable costs (box 25)", totalCost.toFixed(2)]);
    rows.push(["Gains before losses (box 26)", liab.gains.toFixed(2)]);
    rows.push(["Losses in the year (box 27)", liab.losses.toFixed(2)]);
    rows.push(["Annual exempt amount", liab.aea.toFixed(2)]);
    rows.push(["Taxable gain", liab.taxable.toFixed(2)]);
    liab.breakdown.forEach((b) => rows.push([`Taxed at ${fmtRate(b.rate)}`, b.amount.toFixed(2), `tax ${b.tax.toFixed(2)}`]));
    rows.push(["CGT due", liab.tax.toFixed(2)]);
    rows.push(["Reporting required", liab.reporting ? "Yes" : "No"]);
    const text = rows.map((r) => r.map(csvCell).join(",")).join("\n");
    let dl = false;
    try {
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const a = document.createElement("a"); a.href = url; a.download = `cgt-report-${yr.replace("/", "-")}.csv`;
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); dl = true;
    } catch { /* sandbox */ }
    try { await navigator.clipboard.writeText(text); flash(dl ? "CSV downloaded (also copied)." : "Download blocked here — CSV copied to clipboard."); }
    catch { flash(dl ? "CSV downloaded." : "Couldn't export in this frame — use the deployed app."); }
  };

  if (!taxYears.length) return <Empty msg="No disposals to report. Add or import transactions first." />;
  return (
    <div className="space-y-4">
      <div className="no-print"><CgtScopeBanner tool="report" /></div>
      <div className="flex items-end gap-3 flex-wrap no-print">
        <Field label="Tax year">
          <select value={yr} onChange={(e) => setRy(e.target.value)} className="input num">
            {taxYears.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </Field>
        <button onClick={() => window.print()} className="btn-accent"><Printer size={15} /> Print / Save as PDF</button>
        <button onClick={exportCSV} className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]"><Download size={15} /> Download CSV</button>
        {msg && <span className="text-xs text-[var(--muted)]">{msg}</span>}
      </div>

      {/* printable report */}
      <div className="print-area rounded-xl border border-[var(--border)] bg-[var(--panel)] p-6 space-y-5">
        <div className="flex items-baseline justify-between border-b border-[var(--border)] pb-3">
          <div>
            <h2 className="text-lg font-semibold">Capital Gains Tax computation</h2>
            <p className="text-sm text-[var(--muted)]">Listed shares &amp; securities · Tax year {yr}</p>
          </div>
          <span className="text-xs text-[var(--muted)]">Generated {todayISO()}</span>
        </div>

        <p className="text-xs text-[var(--muted)]">
          Individual UK gilts are excluded throughout this computation — they're CGT-exempt under TCGA 1992 s115. Their coupon income is reported separately as interest (see the Income and Gilts tabs), not here.
        </p>

        <div>
          <h3 className="text-sm font-semibold mb-2">Summary (SA108)</h3>
          <table className="w-full text-sm">
            <tbody className="num">
              {[
                ["Number of disposals", num(yd.length, 0)],
                ["Disposal proceeds — box 24", gbp(liab.proceeds)],
                ["Allowable costs — box 25", gbp(totalCost)],
                ["Gains in the year before losses — box 26", gbp(liab.gains)],
                ["Losses in the year — box 27", gbp(liab.losses)],
                ["Annual exempt amount", gbp(liab.aea)],
                ...(liab.usedCarried ? [["Losses brought forward used", gbp(liab.usedCarried)]] : []),
                ["Net taxable gain", gbp(liab.taxable)],
                ...liab.breakdown.map((b) => [`  taxed at ${fmtRate(b.rate)}`, `${gbp(b.amount)}  →  ${gbp(b.tax)}`]),
              ].map(([k, v], i) => (
                <tr key={i} className="border-b border-[var(--border)]">
                  <td className="py-1.5 font-sans text-[var(--muted)]">{k}</td>
                  <td className="py-1.5 text-right">{v}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-[var(--border)]">
                <td className="py-2 font-sans font-semibold">CGT due</td>
                <td className="py-2 text-right font-semibold text-[var(--loss)]">{gbp(liab.tax)}</td>
              </tr>
            </tbody>
          </table>
          <p className="text-xs text-[var(--muted)] mt-2">Reporting {liab.reporting ? "required" : "not required"} for this year (tax due, or proceeds over the reporting threshold).</p>
        </div>

        <div>
          <h3 className="text-sm font-semibold mb-2">Disposal schedule &amp; matching</h3>
          <table className="w-full text-xs">
            <thead className="text-[var(--muted)] border-b border-[var(--border)]">
              <tr>{["Date", "Security", "Method", "Qty", "Proceeds", "Cost", "Gain/loss"].map((h, i) => (
                <th key={i} className={"py-1.5 font-medium " + (i < 3 ? "text-left" : "text-right")}>{h}</th>
              ))}</tr>
            </thead>
            <tbody className="num">
              {yd.map((d) => d.legs.map((l, li) => (
                <tr key={d.id + li} className="border-b border-[var(--border)]">
                  <td className="py-1.5">{li === 0 ? d.date : ""}</td>
                  <td className="py-1.5 font-sans">{li === 0 ? d.ticker : ""}</td>
                  <td className="py-1.5 font-sans">{METHOD[l.method].label}</td>
                  <td className="py-1.5 text-right">{num(l.quantity, l.quantity % 1 ? 4 : 0)}</td>
                  <td className="py-1.5 text-right">{gbp(l.proceeds)}</td>
                  <td className="py-1.5 text-right">{gbp(l.cost)}</td>
                  <td className={"py-1.5 text-right " + (l.gain >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{gbp(l.gain)}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
        <p className="text-[10px] text-[var(--muted)] pt-2 border-t border-[var(--border)]">
          Prepared as a computation to support a Self Assessment return. HMRC share-identification rules applied: same-day, then 30-day, then Section 104 pool. Not tax advice — verify before filing.
        </p>
      </div>
    </div>
  );
}

/* --------------------------- What-if tab ---------------------------- */
function WhatIfTab({ pools, disposals, income, carried, prices = {} }) {
  const tickers = Object.keys(pools).filter((t) => pools[t].qty > 1e-6);
  const [ticker, setTicker] = useState(tickers[0] || "");
  const tk = ticker && pools[ticker] ? ticker : tickers[0] || "";
  const pool = pools[tk] || { qty: 0, cost: 0 };
  const avg = pool.qty ? pool.cost / pool.qty : 0;

  const [priceEdited, setPriceEdited] = useState(false);
  const [priceRaw, setPriceRaw] = useState("");
  // default the price from the Holdings tab unless the user has typed their own
  const price = priceEdited ? priceRaw : (prices[tk] != null ? String(prices[tk]) : "");
  const setPrice = (v) => { setPriceEdited(true); setPriceRaw(v); };
  const [sellQty, setSellQty] = useState("");
  const yearNow = ukTaxYear(todayISO());
  const realisedThisYear = disposals.filter((d) => d.taxYear === yearNow);
  const base = liabilityForYear(realisedThisYear, { income, carriedLosses: carried });

  const p = +price || 0, q = Math.min(+sellQty || 0, pool.qty);
  const hypo = q > 0 && p > 0 ? { date: todayISO(), ticker: tk, quantity: q, proceeds: q * p, gain: q * p - avg * q, taxYear: yearNow, legs: [], cost: avg * q } : null;
  const withHypo = hypo ? liabilityForYear([...realisedThisYear, hypo], { income, carriedLosses: carried }) : base;
  const marginalTax = withHypo.tax - base.tax;

  const aeaHeadroom = Math.max(0, aeaForYear(yearNow) - base.net);
  const maxSharesAea = p > 0 ? sharesForTargetGain(pool.qty, pool.cost, p, aeaHeadroom) : 0;

  if (!tickers.length) return <Empty msg="No open GIA holdings to model. CGT only applies to unsheltered holdings — add GIA buy transactions first." />;
  return (
    <div className="space-y-5">
      <CgtScopeBanner tool="whatif" />
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Holding">
          <select value={tk} onChange={(e) => { setTicker(e.target.value); setPriceEdited(false); setPriceRaw(""); }} className="input">{tickers.map((t) => <option key={t}>{t}</option>)}</select>
        </Field>
        <Field label="Price now (GBP/share)"><input type="number" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="e.g. 60.00" className="input num w-36" /></Field>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Pool quantity" value={num(pool.qty, pool.qty % 1 ? 4 : 0)} />
        <Stat label="Pool cost" value={gbp(pool.cost)} />
        <Stat label="Average cost" value={gbp(avg)} />
        <Stat label={`Realised ${yearNow}`} value={gbp(base.net)} tone={base.net >= 0 ? "gain" : "loss"} />
      </div>

      <div className="grid sm:grid-cols-2 gap-4">
        {/* scenario A */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><FlaskConical size={15} className="text-[var(--accent)]" /> Sell a quantity</h3>
          <Field label="Shares to sell"><input type="number" value={sellQty} onChange={(e) => setSellQty(e.target.value)} className="input num w-full" /></Field>
          {hypo ? (
            <div className="text-sm space-y-1 num">
              <Row k="Proceeds" v={gbp(hypo.proceeds)} />
              <Row k="Cost (pool avg)" v={gbp(hypo.cost)} />
              <Row k="Gain on sale" v={gbp(hypo.gain)} tone={hypo.gain >= 0 ? "gain" : "loss"} />
              <div className="h-px bg-[var(--border)] my-1" />
              <Row k="CGT before" v={gbp(base.tax)} />
              <Row k="CGT after" v={gbp(withHypo.tax)} />
              <Row k="Marginal CGT" v={gbp(marginalTax)} tone="loss" bold />
            </div>
          ) : <p className="text-sm text-[var(--muted)]">Enter a price and quantity to model the disposal.</p>}
        </div>

        {/* scenario B */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
          <h3 className="font-semibold text-sm flex items-center gap-2"><Check size={15} className="text-[var(--gain)]" /> Stay within the {gbp(aeaForYear(yearNow)).replace(".00", "")} allowance</h3>
          {p > 0 ? (
            <div className="text-sm space-y-1 num">
              <Row k="AEA headroom left" v={gbp(aeaHeadroom)} />
              <Row k="Gain per share" v={gbp(p - avg)} />
              <Row k="Max shares, tax-free" v={num(maxSharesAea, 0) + " sh"} tone="gain" bold />
              <p className="text-xs text-[var(--muted)] pt-1 font-sans">Clean sale, no repurchase within 30 days. Selling more triggers CGT on the excess at your marginal rate.</p>
            </div>
          ) : <p className="text-sm text-[var(--muted)]">Enter a current price to see how many shares fit inside this year's allowance.</p>}
        </div>
      </div>
    </div>
  );
}

/* --------------------------- Import tab ----------------------------- */
const FIELDS = ["date", "ticker", "side", "quantity", "nativeCurrency", "nativeAmount", "fxRate", "gbpAmount"];
const FIELDS_DIV = ["date", "ticker", "kind", "nativeCurrency", "nativeAmount", "fxRate", "gbpAmount"];
function ImportTab({ setTxns, setTab, setIncomeEntries, setEriEntries, secMeta, setPensionCashflows }) {
  const [mode, setMode] = useState("ibkr");
  const [wrapper, setWrapper] = useState("GIA");
  const [raw, setRaw] = useState("");
  const [parsed, setParsed] = useState(null);
  const [map, setMap] = useState({});
  const [ib, setIb] = useState(null);       // parseIBKR result
  const [importing, setImporting] = useState(false);
  const [note, setNote] = useState("");
  const [wb, setWb] = useState(null);        // parsed iShares workbook: { fileName, sheets: [{name, headerRowIdx, colMap, headerCells, rows}] }
  const [activeSheet, setActiveSheet] = useState(0);
  const [onlyHeld, setOnlyHeld] = useState(true);
  const [checked, setChecked] = useState({}); // isin -> bool
  const [wbBusy, setWbBusy] = useState(false);

  const readFile = (e, cb) => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = () => cb(String(r.result)); r.readAsText(f); e.target.value = ""; };

  // ---- IBKR ----
  const parseIb = (text) => { const t = (text ?? raw).trim(); if (!t) return; setIb(parseIBKR(t, { defaultWrapper: wrapper })); };
  React.useEffect(() => { if (ib) setIb((r) => ({ ...r, trades: r.trades.map((t) => ({ ...t, wrapper })), income: r.income.map((t) => ({ ...t, wrapper })) })); }, [wrapper]); // eslint-disable-line
  const doImportIb = async () => {
    if (!ib) return; setImporting(true); setNote("");
    const cache = {};
    const resolve = async (row, gbpKey) => {
      if (!row.needsFx) return;
      const k = row.nativeCurrency + row.date;
      if (!(k in cache)) cache[k] = await fxHistorical(row.nativeCurrency, row.date);
      const fx = cache[k];
      if (fx) { row.fxRate = fx; row[gbpKey] = Math.round(row.nativeAmount * fx * 100) / 100; }
    };
    const trades = ib.trades.map((t) => ({ ...t })), income = ib.income.map((t) => ({ ...t }));
    for (const t of trades) await resolve(t, "gbpAmount");
    for (const t of income) await resolve(t, "amount");
    const newTxns = trades.filter((t) => t.gbpAmount != null).map((t) => ({ id: uid(), date: t.date, ticker: t.ticker, isin: t.isin, side: t.side, quantity: t.quantity, nativeCurrency: t.nativeCurrency, nativeAmount: t.nativeAmount, fxRate: t.fxRate || 1, gbpAmount: t.gbpAmount, wrapper: t.wrapper, note: "IBKR import" }));
    const newIncome = income.filter((t) => t.amount != null).map((t) => ({ id: uid(), date: t.date, ticker: t.ticker, kind: t.kind, amount: t.amount, wrapper: t.wrapper, note: "IBKR import" }));
    const skipped = (trades.length - newTxns.length) + (income.length - newIncome.length);
    setTxns((p) => [...p, ...newTxns]);
    if (newIncome.length) setIncomeEntries((p) => [...p, ...newIncome]);
    setImporting(false);
    if (skipped) { setNote(`Imported ${newTxns.length} trades and ${newIncome.length} income rows. ${skipped} row(s) skipped — FX could not be resolved; add them manually.`); }
    else setTab(newTxns.length ? "ledger" : "income");
  };

  // ---- generic ----
  const parse = () => {
    const res = Papa.parse(raw.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    const cols = res.meta.fields || [];
    const find = (re) => cols.find((c) => re.test(c));
    const guess = {};
    guess.date = find(/date|trade date|settl/i); guess.ticker = find(/ticker|symbol|instrument|stock/i);
    guess.side = find(/side|action|type|buy.?sell|b\/s/i); guess.quantity = find(/qty|quantity|shares|units/i);
    guess.nativeCurrency = find(/currency|ccy/i); guess.nativeAmount = find(/amount|proceeds|cost|value|consideration|net/i);
    guess.fxRate = find(/fx|rate|exchange/i); guess.gbpAmount = find(/gbp|sterling/i);
    setParsed(res.data); setMap(guess);
  };
  const normSide = (v) => /sell|^s$|sld|disp/i.test(v || "") ? "SELL" : "BUY";
  const preview = useMemo(() => (!parsed ? [] : parsed.slice(0, 5).map((r) => mapRow(r, map, normSide, wrapper))), [parsed, map, wrapper]);
  const doImport = () => {
    const rows = parsed.map((r) => mapRow(r, map, normSide, wrapper)).filter((t) => t.date && t.ticker && +t.quantity > 0);
    setTxns((p) => [...p, ...rows]); setTab("ledger");
  };

  // ---- generic dividend/interest CSV ----
  const [rawDiv, setRawDiv] = useState("");
  const [parsedDiv, setParsedDiv] = useState(null);
  const [mapDiv, setMapDiv] = useState({});
  const parseDiv = () => {
    const res = Papa.parse(rawDiv.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    const cols = res.meta.fields || [];
    const find = (re) => cols.find((c) => re.test(c));
    const guess = {};
    guess.date = find(/date|pay date|ex.?date|settl/i);
    guess.ticker = find(/ticker|symbol|instrument|stock|security/i);
    guess.kind = find(/kind|type|category/i);
    guess.nativeCurrency = find(/currency|ccy/i);
    guess.nativeAmount = find(/amount|gross|net|value|proceeds/i);
    guess.fxRate = find(/fx|rate|exchange/i);
    guess.gbpAmount = find(/gbp|sterling/i);
    setParsedDiv(res.data); setMapDiv(guess);
  };
  const normKind = (v) => /interest|coupon/i.test(v || "") ? "interest" : "dividend";
  const previewDiv = useMemo(() => (!parsedDiv ? [] : parsedDiv.slice(0, 5).map((r) => mapDivRow(r, mapDiv, normKind, wrapper))), [parsedDiv, mapDiv, wrapper]);
  const doImportDiv = () => {
    const rows = parsedDiv.map((r) => mapDivRow(r, mapDiv, normKind, wrapper)).filter((t) => t.date && t.ticker && t.amount > 0);
    setIncomeEntries((p) => [...p, ...rows]); setTab("income");
  };

  // ---- pension contribution/switch CSV (Citi/L&G, Aviva, or any other provider) ----
  const [rawPension, setRawPension] = useState("");
  const [parsedPension, setParsedPension] = useState(null);
  const [mapPension, setMapPension] = useState({});
  const [pensionProvider, setPensionProvider] = useState("");
  const existingProviders = useMemo(() => [...new Set(Object.values(secMeta || {}).map((m) => m.provider).filter(Boolean))].sort(), [secMeta]);
  const parsePension = () => {
    const res = Papa.parse(rawPension.trim(), { header: true, skipEmptyLines: true });
    if (!res.data?.length) return;
    setParsedPension(res.data); setMapPension(guessPensionColumns(res.meta.fields || []));
  };
  const previewPension = useMemo(
    () => (!parsedPension || !pensionProvider ? [] : parsedPension.slice(0, 8).map((r) => mapPensionRow(r, mapPension, pensionProvider)).filter(Boolean)),
    [parsedPension, mapPension, pensionProvider]
  );
  const pensionSkipped = useMemo(
    () => (!parsedPension || !pensionProvider ? 0 : parsedPension.length - parsedPension.map((r) => mapPensionRow(r, mapPension, pensionProvider)).filter(Boolean).length),
    [parsedPension, mapPension, pensionProvider]
  );
  const doImportPension = () => {
    if (!pensionProvider.trim()) return;
    const rows = parsedPension.map((r) => mapPensionRow(r, mapPension, pensionProvider.trim())).filter(Boolean)
      .map((r) => ({ id: uid(), ...r, gbpAmount: r.ccy === "GBP" ? r.nativeAmount : null }));
    setPensionCashflows((p) => [...p, ...rows]);
    setTab("pension");
  };

  // ---- iShares / issuer ERI workbook ----
  const heldIsins = useMemo(() => new Set(Object.values(secMeta || {}).map((s) => (s.isin || "").toUpperCase()).filter(Boolean)), [secMeta]);
  const isinToTicker = useMemo(() => {
    const m = {}; for (const [tk, s] of Object.entries(secMeta || {})) if (s.isin) m[s.isin.toUpperCase()] = tk; return m;
  }, [secMeta]);

  const readWorkbookFile = (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    setWbBusy(true); setWb(null); setChecked({});
    const r = new FileReader();
    r.onload = async () => {
      try {
        const XLSX = await import("xlsx"); // loaded on demand — see note at top of file
        const data = new Uint8Array(r.result);
        const book = XLSX.read(data, { type: "array", cellDates: true });
        const sheets = book.SheetNames.map((name) => ({ name, aoa: XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, raw: true, defval: "" }) }));
        const result = parseISharesWorkbook(sheets, null); // parse unfiltered; "only held" is a display filter below
        const bestSheet = result.reduce((best, s, i) => {
          const scoreOf = (idx) => result[idx].rows.filter((row) => heldIsins.has(row.isin)).length || result[idx].rows.length;
          return scoreOf(i) > scoreOf(best) ? i : best;
        }, 0);
        setWb({ fileName: f.name, sheets: result });
        setActiveSheet(bestSheet);
      } catch (err) {
        setWb({ fileName: f.name, sheets: [], error: err.message || "Could not read this file as a spreadsheet." });
      }
      setWbBusy(false);
    };
    r.readAsArrayBuffer(f);
    e.target.value = "";
  };

  const sheet = wb?.sheets?.[activeSheet];
  const allRows = sheet?.rows || [];
  const rows = useMemo(() => onlyHeld ? allRows.filter((r) => heldIsins.has(r.isin)) : allRows, [allRows, onlyHeld, heldIsins]);
  React.useEffect(() => {
    const c = {}; rows.forEach((r) => { c[r.isin] = true; }); setChecked(c);
  }, [sheet, onlyHeld]); // eslint-disable-line
  const toggleAll = (v) => { const c = {}; rows.forEach((r) => { c[r.isin] = v; }); setChecked(c); };
  const selectedCount = rows.filter((r) => checked[r.isin]).length;

  const doImportEri = async () => {
    const selected = rows.filter((r) => checked[r.isin]);
    const fxCache = {};
    const toAdd = [];
    for (const r of selected) {
      const ticker = isinToTicker[r.isin] || r.isin;
      let fxRate = r.currency === "GBP" || r.currency === "GBp" ? 1 : 0;
      if (fxRate === 0 && r.distributionDate) {
        const k = r.currency + r.distributionDate;
        if (!(k in fxCache)) fxCache[k] = await fxHistorical(r.currency, r.distributionDate);
        fxRate = fxCache[k] || 0;
      }
      const e = { id: uid(), ticker, periodEnd: r.periodEnd, distributionDate: r.distributionDate, perShare: +r.perShare || 0, currency: r.currency || "GBP", fxRate, treatment: r.treatment || "dividend" };
      if (e.ticker && e.periodEnd && e.distributionDate && e.perShare) toAdd.push(e);
    }
    if (!toAdd.length) return;
    setEriEntries((p) => [...p, ...toAdd]);
    const unresolvedFx = toAdd.filter((e) => e.currency !== "GBP" && e.currency !== "GBp" && !e.fxRate).length;
    if (unresolvedFx) setNote(`Imported ${toAdd.length} ERI entries. ${unresolvedFx} needed an FX rate that couldn't be fetched — set it manually on the Income tab.`);
    else setTab("income");
  };

  const Tab = ({ k, label }) => (
    <button onClick={() => setMode(k)} className={"px-3 py-1.5 text-sm rounded-lg border " + (mode === k ? "bg-[var(--accent)] text-[var(--accent-fg)] border-transparent" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>{label}</button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <Tab k="ibkr" label="Interactive Brokers" /><Tab k="generic" label="Generic CSV" /><Tab k="dividends" label="Dividends CSV" /><Tab k="pension" label="Pension contributions" /><Tab k="ishares" label="iShares ERI" />
        <span className="ml-auto" />
        {mode !== "ishares" && <Field label="Import into wrapper"><select value={wrapper} onChange={(e) => setWrapper(e.target.value)} className="input">{WRAPPERS.map((w) => <option key={w}>{w}</option>)}</select></Field>}
      </div>

      {mode === "ibkr" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">Paste (or upload) an IBKR <strong>Flex Query</strong> CSV or an <strong>Activity Statement</strong> CSV. Trades and dividends/interest are both picked up. A Flex query carries an FX-to-base rate, so GBP conversion is automatic; Activity exports lack it, so non-GBP rows are converted by trade-date FX on import. {wrapper !== "GIA" && <span className="text-[var(--fg)]">Note: {wrapper} is tax-sheltered, so these rows won't affect CGT or income tax.</span>}</p>
            <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} placeholder={"Symbol,ISIN,TradeDate,Buy/Sell,Quantity,TradePrice,Proceeds,IBCommission,CurrencyPrimary,FXRateToBase,AssetClass\nAAPL,US0378331005,20240115,BUY,10,180,-1800,-1,USD,0.79,STK"} className="input num w-full font-mono text-xs" />
            <div className="flex items-center gap-2">
              <button onClick={() => parseIb()} className="btn-accent"><Wand2 size={15} /> Parse</button>
              <label className="text-sm text-[var(--accent)] cursor-pointer flex items-center gap-1"><Upload size={14} /> Upload CSV<input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => readFile(e, (txt) => { setRaw(txt); parseIb(txt); })} /></label>
            </div>
          </div>

          {ib && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="font-semibold">{ib.format === "activity" ? "Activity Statement" : "Flex Query"} detected</span>
                <span className="num">{ib.trades.length} trades</span>
                <span className="num">{ib.income.filter((i) => i.kind === "dividend").length} dividends</span>
                <span className="num">{ib.income.filter((i) => i.kind === "interest").length} interest</span>
              </div>
              {ib.warnings.map((w, i) => (
                <div key={i} className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{w}</div>
              ))}
              {ib.trades.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "side", "qty", "ccy", "native", "GBP"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                    <tbody className="num">
                      {ib.trades.slice(0, 6).map((t, i) => (
                        <tr key={i} className="border-t border-[var(--border)]">
                          <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.ticker}</td><td className="px-2 py-1">{t.side}</td>
                          <td className="px-2 py-1">{num(t.quantity, t.quantity % 1 ? 4 : 0)}</td><td className="px-2 py-1">{t.nativeCurrency}</td>
                          <td className="px-2 py-1">{num(t.nativeAmount)}</td><td className="px-2 py-1">{t.gbpAmount == null ? "FX on import" : gbp(t.gbpAmount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {ib.trades.length > 6 && <p className="text-xs text-[var(--muted)] mt-1">+{ib.trades.length - 6} more…</p>}
                </div>
              )}
              {note && <div className="text-xs text-[var(--muted)]">{note}</div>}
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">Imports into <strong>{wrapper}</strong>. Trades → ledger, dividends/interest → Income tab.</span>
                <button onClick={doImportIb} disabled={importing} className="btn-accent">{importing ? <RefreshCw size={15} className="animate-spin" /> : <FileUp size={15} />} Import</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "generic" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">Paste a CSV from any broker. Columns are auto-mapped — adjust below if needed. Rows import into <strong>{wrapper}</strong>.</p>
            <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} placeholder={"Date,Symbol,Action,Quantity,Currency,Amount,FXRate\n2025-06-02,WFC,SELL,200,USD,18718,0.78"} className="input num w-full font-mono text-xs" />
            <button onClick={parse} className="btn-accent"><Wand2 size={15} /> Parse & map</button>
          </div>
          {parsed && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {FIELDS.map((f) => (
                  <Field key={f} label={f}>
                    <select value={map[f] || ""} onChange={(e) => setMap((m) => ({ ...m, [f]: e.target.value }))} className="input w-full text-xs">
                      <option value="">—</option>
                      {(Object.keys(parsed[0] || {})).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "side", "qty", "ccy", "native", "fx", "gbp"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody className="num">
                    {preview.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.ticker}</td><td className="px-2 py-1">{t.side}</td>
                        <td className="px-2 py-1">{t.quantity}</td><td className="px-2 py-1">{t.nativeCurrency}</td><td className="px-2 py-1">{num(t.nativeAmount)}</td>
                        <td className="px-2 py-1">{num(t.fxRate, 4)}</td><td className="px-2 py-1">{gbp(t.gbpAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">{parsed.length} rows ready. GBP fills from native × FX when GBP column is unmapped.</span>
                <button onClick={doImport} className="btn-accent"><FileUp size={15} /> Import {parsed.length} rows</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "dividends" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Paste a dividend/interest CSV from any broker (a tax certificate export, consolidated statement, etc). Columns are auto-mapped — adjust below if needed. Rows import into <strong>{wrapper}</strong> as income entries (same as adding them by hand on the Income tab), amounts net of any withholding tax already deducted at source.
            </p>
            <textarea value={rawDiv} onChange={(e) => setRawDiv(e.target.value)} rows={7} placeholder={"Date,Symbol,Type,Currency,Amount\n2025-06-15,CSP1,Dividend,USD,42.10\n2025-07-01,,Interest,GBP,15.00"} className="input num w-full font-mono text-xs" />
            <button onClick={parseDiv} className="btn-accent"><Wand2 size={15} /> Parse & map</button>
          </div>
          {parsedDiv && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {FIELDS_DIV.map((f) => (
                  <Field key={f} label={f}>
                    <select value={mapDiv[f] || ""} onChange={(e) => setMapDiv((m) => ({ ...m, [f]: e.target.value }))} className="input w-full text-xs">
                      <option value="">—</option>
                      {(Object.keys(parsedDiv[0] || {})).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[var(--muted)]"><tr>{["date", "ticker", "kind", "GBP amount"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody className="num">
                    {previewDiv.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.ticker || "—"}</td>
                        <td className="px-2 py-1 capitalize">{t.kind}</td><td className="px-2 py-1">{gbp(t.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">{parsedDiv.length} rows ready. GBP fills from native × FX when GBP column is unmapped; ticker can be left blank for interest.</span>
                <button onClick={doImportDiv} className="btn-accent"><FileUp size={15} /> Import {parsedDiv.length} rows</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "pension" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Paste a contribution/switch history from a pension provider — column names vary (confirmed against real Citi/L&G and Aviva exports, auto-detected below), and "Switch" rows (fund-to-fund transfers with no net cashflow) are automatically excluded. Everything else with a real, nonzero amount becomes a cashflow used for that provider's money-weighted return (XIRR) on the Pension &amp; LISA tab — it does <em>not</em> create fund transactions, since these exports don't break contributions down by fund.
            </p>
            <Field label="Provider (existing or new)">
              <input list="import-pension-providers" value={pensionProvider} onChange={(e) => setPensionProvider(e.target.value)} className="input w-56" placeholder="e.g. L&G (Citi)" />
              <datalist id="import-pension-providers">{existingProviders.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
            <textarea value={rawPension} onChange={(e) => setRawPension(e.target.value)} rows={7} placeholder={"Date,Symbol,Type,Currency,Amount\n2023-01-06,Aviva Pension,Employer Contribution,GBP,1284.50\n2023-01-27,Aviva Pension,Employer Contribution,GBP,7129.50"} className="input num w-full font-mono text-xs" />
            <button onClick={parsePension} className="btn-accent"><Wand2 size={15} /> Parse & map</button>
          </div>
          {parsedPension && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {["date", "type", "currency", "amount"].map((f) => (
                  <Field key={f} label={f}>
                    <select value={mapPension[f] || ""} onChange={(e) => setMapPension((m) => ({ ...m, [f]: e.target.value }))} className="input w-full text-xs">
                      <option value="">—</option>
                      {(Object.keys(parsedPension[0] || {})).map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </Field>
                ))}
              </div>
              {!pensionProvider.trim() && <p className="text-xs text-[var(--loss)]">Set a provider above before importing.</p>}
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-[var(--muted)]"><tr>{["date", "type", "currency", "amount"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}</tr></thead>
                  <tbody className="num">
                    {previewPension.map((t, i) => (
                      <tr key={i} className="border-t border-[var(--border)]">
                        <td className="px-2 py-1">{t.date}</td><td className="px-2 py-1">{t.type}</td>
                        <td className="px-2 py-1">{t.ccy}</td><td className="px-2 py-1">{gbp(t.nativeAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--muted)]">
                  {parsedPension.length} rows in file, {parsedPension.length - pensionSkipped} contributions detected{pensionSkipped ? ` (${pensionSkipped} switches/zero-amount rows excluded)` : ""}. Preview shows the first 8.
                </span>
                <button onClick={doImportPension} disabled={!pensionProvider.trim()} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import {parsedPension.length - pensionSkipped} cashflows</button>
              </div>
            </div>
          )}
        </>
      )}

      {mode === "ishares" && (
        <>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
            <p className="text-sm text-[var(--muted)]">
              Upload an iShares/BlackRock <strong>"UK Reportable Income"</strong> workbook — one file per fund umbrella (iShares Plc, iShares III plc, iShares VII plc, etc.), downloaded from <span className="font-mono text-xs">ishares.com</span> → Literature → Tax Information. Rows are matched to your holdings by ISIN and added as excess reportable income entries — GIA only, since ISA/SIPP are exempt.
            </p>
            <label className="inline-flex items-center gap-2 text-sm text-[var(--accent)] cursor-pointer">
              <Upload size={14} /> Upload workbook (.xlsx/.xls)
              <input type="file" accept=".xlsx,.xls" className="hidden" onChange={readWorkbookFile} />
            </label>
            {wbBusy && <div className="flex items-center gap-2 text-xs text-[var(--muted)]"><RefreshCw size={13} className="animate-spin" /> Reading workbook…</div>}
            {wb?.error && (
              <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}><AlertTriangle size={14} className="mt-0.5 shrink-0" />{wb.error}</div>
            )}
          </div>

          {wb && !wb.error && (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
              <div className="flex items-center gap-3 flex-wrap text-sm">
                <span className="font-semibold truncate max-w-[16rem]" title={wb.fileName}>{wb.fileName}</span>
                {wb.sheets.length > 1 && (
                  <select value={activeSheet} onChange={(e) => setActiveSheet(+e.target.value)} className="input text-xs w-auto">
                    {wb.sheets.map((s, i) => <option key={i} value={i}>{s.name} ({s.rows.length} held match{s.rows.length === 1 ? "" : "es"})</option>)}
                  </select>
                )}
                <label className="flex items-center gap-1.5 text-xs cursor-pointer ml-auto">
                  <input type="checkbox" checked={onlyHeld} onChange={(e) => setOnlyHeld(e.target.checked)} className="accent-[var(--accent)]" /> Only show my holdings
                </label>
              </div>

              {sheet && sheet.headerRowIdx < 0 && (
                <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 text-[var(--loss)]" style={{ background: "color-mix(in srgb, var(--loss) 10%, transparent)" }}>
                  <AlertTriangle size={14} className="mt-0.5 shrink-0" />Couldn't find a header row with an ISIN column in this sheet — it may not be a reportable-income report, or uses a layout this importer doesn't recognise yet.
                </div>
              )}

              {sheet && sheet.headerRowIdx >= 0 && rows.length === 0 && (
                <Empty msg={onlyHeld ? "No rows in this sheet match your current holdings' ISINs. Try unchecking \"Only show my holdings\", or check you've got the right umbrella file." : "No ERI rows found in this sheet (all excess income was zero, or no data rows present)."} />
              )}

              {rows.length > 0 && (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead className="text-[var(--muted)]">
                        <tr>
                          <th className="px-2 py-1 text-left"><input type="checkbox" checked={selectedCount === rows.length} onChange={(e) => toggleAll(e.target.checked)} className="accent-[var(--accent)]" /></th>
                          {["Fund", "Ticker", "ISIN", "Period end", "Distribution date", "ERI/unit", "Ccy", "Taxed as"].map((h) => <th key={h} className="px-2 py-1 text-left">{h}</th>)}
                        </tr>
                      </thead>
                      <tbody className="num">
                        {rows.map((r) => {
                          const ticker = isinToTicker[r.isin];
                          return (
                            <tr key={r.isin + r.periodEnd} className="border-t border-[var(--border)]">
                              <td className="px-2 py-1"><input type="checkbox" checked={!!checked[r.isin]} onChange={(e) => setChecked((c) => ({ ...c, [r.isin]: e.target.checked }))} className="accent-[var(--accent)]" /></td>
                              <td className="px-2 py-1 max-w-[14rem] truncate" title={r.fundName}>{r.fundName}</td>
                              <td className="px-2 py-1 font-medium">{ticker || <span className="text-[var(--loss)]" title="No ticker in your holdings has this ISIN — add it on the Holdings tab first">unmatched</span>}</td>
                              <td className="px-2 py-1 font-mono text-[var(--muted)]">{r.isin}</td>
                              <td className="px-2 py-1">{r.periodEnd}</td>
                              <td className="px-2 py-1">{r.distributionDate}</td>
                              <td className="px-2 py-1">{r.perShare}</td>
                              <td className="px-2 py-1">{r.currency}</td>
                              <td className="px-2 py-1 capitalize">{r.treatment}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <p className="text-xs text-[var(--muted)]">
                    "Taxed as" comes straight from the report's own "Meets definition of a Bond Fund" flag — bond funds are taxed as interest, everything else as dividend. Rows marked <span className="text-[var(--loss)]">unmatched</span> don't have a ticker with that ISIN on your Holdings tab; add the ISIN there first if you want to import them. Non-GBP amounts have their FX rate fetched automatically for the distribution date on import.
                  </p>
                  {note && <div className="text-xs text-[var(--muted)]">{note}</div>}
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-[var(--muted)]">{selectedCount}/{rows.length} selected.</span>
                    <button onClick={doImportEri} disabled={!selectedCount} className="btn-accent disabled:opacity-50"><FileUp size={15} /> Import {selectedCount} ERI entr{selectedCount === 1 ? "y" : "ies"}</button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
function mapRow(r, map, normSide, wrapper) {
  const g = (f) => (map[f] ? r[map[f]] : "");
  const ccy = (g("nativeCurrency") || "GBP").toUpperCase().trim();
  const native = parseFloat(String(g("nativeAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  let fx = parseFloat(g("fxRate")) || (ccy === "GBP" ? 1 : 0);
  let gbpA = parseFloat(String(g("gbpAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  if (!gbpA && native && fx) gbpA = +(native * fx).toFixed(2);
  if (!fx && gbpA && native) fx = +(gbpA / native).toFixed(6);
  return {
    id: uid(), date: (g("date") || "").slice(0, 10), ticker: (g("ticker") || "").toUpperCase().trim(),
    side: normSide(g("side")), quantity: Math.abs(parseFloat(g("quantity")) || 0),
    nativeCurrency: ccy, nativeAmount: native, fxRate: fx || 1, gbpAmount: gbpA, wrapper: wrapper || "GIA", note: "imported",
  };
}
function mapDivRow(r, map, normKind, wrapper) {
  const g = (f) => (map[f] ? r[map[f]] : "");
  const ccy = (g("nativeCurrency") || "GBP").toUpperCase().trim();
  const native = parseFloat(String(g("nativeAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  let fx = parseFloat(g("fxRate")) || (ccy === "GBP" ? 1 : 0);
  let gbpA = parseFloat(String(g("gbpAmount")).replace(/[^0-9.\-]/g, "")) || 0;
  if (!gbpA && native && fx) gbpA = +(native * fx).toFixed(2);
  if (!fx && gbpA && native) fx = +(gbpA / native).toFixed(6);
  if (!gbpA && ccy === "GBP") gbpA = native;
  return {
    id: uid(), date: (g("date") || "").slice(0, 10), ticker: (g("ticker") || "").toUpperCase().trim(),
    kind: normKind(g("kind")), amount: gbpA, wrapper: wrapper || "GIA", note: "imported",
  };
}

/* ----------------------------- atoms -------------------------------- */
function IconBtn({ children, as = "button", ...p }) {
  const C = as; return <C {...p} className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)] text-[var(--fg)] cursor-pointer">{children}</C>;
}
function Field({ label, children }) {
  return <label className="flex flex-col gap-1"><span className="text-xs text-[var(--muted)]">{label}</span>{children}</label>;
}
function Stat({ label, value, sub, tone, big }) {
  const c = tone === "gain" ? "text-[var(--gain)]" : tone === "loss" ? "text-[var(--loss)]" : "text-[var(--fg)]";
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className={`num font-semibold ${big ? "text-2xl" : "text-lg"} ${c} mt-0.5`}>{value}</div>
      {sub && <div className="text-xs text-[var(--muted)] mt-0.5">{sub}</div>}
    </div>
  );
}
function Row({ k, v, tone, bold }) {
  const c = tone === "gain" ? "text-[var(--gain)]" : tone === "loss" ? "text-[var(--loss)]" : "";
  return <div className="flex justify-between"><span className="text-[var(--muted)] font-sans">{k}</span><span className={`${c} ${bold ? "font-semibold" : ""}`}>{v}</span></div>;
}
function MethodChip({ m }) {
  const d = METHOD[m];
  return <span className="text-xs font-medium px-2 py-0.5 rounded-full" style={{ color: `var(${d.v})`, background: "var(--chip)" }}>{d.label}</span>;
}
function Empty({ msg }) {
  return <div className="rounded-xl border border-dashed border-[var(--border)] py-12 text-center text-sm text-[var(--muted)]">{msg}</div>;
}

/* inline utility classes used above */
const _style = document.createElement("style");
_style.textContent = `
  .input{background:var(--panel2);border:1px solid var(--border);border-radius:.5rem;padding:.4rem .6rem;font-size:.875rem;color:var(--fg);outline:none;box-sizing:border-box;line-height:1.25}
  input.input,select.input{height:2.25rem}
  textarea.input{min-height:9rem;line-height:1.5;resize:vertical}
  .input:focus{border-color:var(--accent)}
  select.input{appearance:none;-webkit-appearance:none;background-image:url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none' stroke='%23888' stroke-width='1.5'%3e%3cpath d='M5 7.5l5 5 5-5'/%3e%3c/svg%3e");background-repeat:no-repeat;background-position:right .5rem center;background-size:1rem;padding-right:1.75rem}
  .btn-accent{display:inline-flex;align-items:center;gap:.4rem;background:var(--accent);color:var(--accent-fg);font-size:.875rem;font-weight:600;padding:.45rem .8rem;border-radius:.5rem;cursor:pointer;height:2.25rem;box-sizing:border-box}
  .btn-accent:hover{opacity:.92}
`;
if (typeof document !== "undefined" && !document.getElementById("cgt-util")) { _style.id = "cgt-util"; document.head.appendChild(_style); }
