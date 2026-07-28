/* ======================================================================
   UK TAX ENGINE — CGT liability, investment-income tax, and the multi-year
   AEA harvesting optimiser, extracted VERBATIM from CgtDashboard.jsx so the
   computations are pure, importable, and node-tested (uk-tax.test.mjs).
   Behaviour is unchanged from the inlined version.
   ====================================================================== */

// Historical UK tax-year parameters for SHARES / non-property assets.
// aea = annual exempt amount; basicLimit = income-tax basic-rate limit (band above the
// personal allowance); pa = personal allowance; reportThreshold = proceeds figure above
// which a disposal must be reported (4xAEA before 2023/24, fixed £50k after). 2024/25
// splits at the 30 Oct 2024 Budget (10/20 -> 18/24). Verified against GOV.UK / HoC Library.
const _Y = (aea, basicLimit, pa, reportThreshold, rates) => ({ aea, basicLimit, pa, reportThreshold, rates });
const _ONE = (basic, higher) => [{ from: "0000-00-00", basic, higher }];
export const TAX_YEARS = {
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
export const LATEST_YEAR = "2026/27";
export const cfgFor = (year) => TAX_YEARS[year] || { ...TAX_YEARS[LATEST_YEAR], assumed: true };
export const aeaForYear = (year) => cfgFor(year).aea;
export const rateForDate = (cfg, dateStr) => { let p = cfg.rates[0]; for (const r of cfg.rates) if (r.from <= dateStr) p = r; return p; };
// Personal allowance tapers by £1 for every £2 of income over £100,000.
export const paFor = (pa, income) => (income <= 100000 ? pa : Math.max(0, pa - (income - 100000) / 2));

export function liabilityForYear(disposals, { income = 0, carriedLosses = 0 } = {}) {
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
export const sharesForTargetGain = (q, c, p, target) => {
  const per = p - c / q; if (per <= 0) return q; return Math.min(q, Math.floor(target / per));
};

// Chain per-year CGT liability across tax years, carrying losses forward.
// In-year losses offset in-year gains fully; brought-forward losses reduce net
// gains only down to the AEA; unused losses carry forward (4-year claim window).
export function liabilityAllYears(disposals, { incomeByYear = {}, initialCarried = 0 } = {}) {
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

/* ---- UK income tax on investment income (dividends + interest), stacked on
   salary. Nil-rate allowances (PSA, dividend allowance) sit at 0% but occupy band
   space. Verified in uk-tax.test.mjs. ---- */
const _I = (pa, basicLimit, addl, divAllow, div, sav, psa) => ({ pa, basicLimit, addl, divAllow, div, sav, psa });
const _DO = { basic: 0.075, higher: 0.325, addl: 0.381 }, _DM = { basic: 0.0875, higher: 0.3375, addl: 0.3935 }, _DN = { basic: 0.1075, higher: 0.3575, addl: 0.3935 };
const _SAV = { basic: 0.20, higher: 0.40, addl: 0.45 }, _PSA = { basic: 1000, higher: 500, addl: 0 };
export const INCOME_YEARS = {
  "2016/17": _I(11000, 32000, 150000, 5000, _DO, _SAV, _PSA), "2017/18": _I(11500, 33500, 150000, 5000, _DO, _SAV, _PSA),
  "2018/19": _I(11850, 34500, 150000, 2000, _DO, _SAV, _PSA), "2019/20": _I(12500, 37500, 150000, 2000, _DO, _SAV, _PSA),
  "2020/21": _I(12500, 37500, 150000, 2000, _DO, _SAV, _PSA), "2021/22": _I(12570, 37700, 150000, 2000, _DO, _SAV, _PSA),
  "2022/23": _I(12570, 37700, 150000, 2000, _DM, _SAV, _PSA), "2023/24": _I(12570, 37700, 125140, 1000, _DM, _SAV, _PSA),
  "2024/25": _I(12570, 37700, 125140, 500, _DM, _SAV, _PSA), "2025/26": _I(12570, 37700, 125140, 500, _DM, _SAV, _PSA),
  "2026/27": _I(12570, 37700, 125140, 500, _DN, _SAV, _PSA),
};
export const incomeCfg = (year) => INCOME_YEARS[year] || { ...INCOME_YEARS["2026/27"], assumed: true };
function _walk(pos, amount, basicTop, higherTop, rates) {
  const bounds = [basicTop, higherTop, Infinity], rs = [rates.basic, rates.higher, rates.addl];
  let tax = 0, p = pos, rem = amount;
  for (let i = 0; i < 3 && rem > 1e-9; i++) { if (p >= bounds[i]) continue; const take = Math.min(rem, bounds[i] - p); tax += take * rs[i]; p += take; rem -= take; }
  return { tax, end: p };
}
export function investmentIncomeTax({ salary = 0, interest = 0, dividends = 0, year } = {}) {
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

/* ---- Multi-year AEA disposal optimiser. Staggers realisation of an
   embedded gain across tax years so each year's annual exempt amount (and,
   where the taxpayer has any, the room left in their basic-rate band, taxed
   at 18%) does the work. Verified in uk-tax.test.mjs.

   Two modes, because they answer different questions:
   - "selldown" (default): actually SELL the appreciated shares to raise
     cash. Quantity DECREMENTS each year and can never fall below zero, so
     the cumulative shares sold can never exceed what's held — this is the
     bug the old wash-only model had (it re-inflated the position by
     assuming a rebuy every year, so multi-year "disposals" summed to more
     than the holding). Reports the proceeds (cash) raised.
   - "wash": bed-&-ISA / bed-&-spouse — sell AND rebuy at market to reset
     the base cost while KEEPING the position. Quantity is unchanged; the
     embedded gain shrinks because avg cost rises. Here the cumulative
     shares transacted legitimately exceeds the holding (you rebuy each
     year) — the UI labels it as a repurchase, not a net disposal, and
     there are no net proceeds.

   The 18% band: `useBasicBand` widens each year's harvestable gain by the
   room left in the basic-rate band (gains there are taxed at 18%). A
   taxpayer whose income already fills the basic-rate band has ZERO room, so
   the toggle correctly does nothing for them — the caller reads
   `bandRoomStart` to disable/explain it rather than showing a dead tick.

   `objective` picks WHICH lots each year's allowance is spent on. The gain
   sheltered per year is capped by the allowance either way, so this doesn't
   change the tax — it changes cash raised and units kept:
   - "gain" (default): sell the HIGHEST gain-per-share lots first. Clears the
     biggest latent gains using the fewest shares, so the most units stay
     invested; with growth those retained units keep compounding, so more
     total gain gets washed over the horizon.
   - "cash": sell the LOWEST gain-per-share (highest cost-basis) lots first.
     Raises the most cash per £ of allowance and exits the position fastest.

   `proceeds`/`totalProceeds` are the CASH RAISED and are only meaningful in
   sell-down mode. In wash mode you rebuy immediately, so net cash is zero —
   we report proceeds as 0 there rather than the gross turnover, which would
   balloon geometrically with growth (constant units × a compounding price)
   and mean nothing. ---- */
export const nextTaxYear = (y) => { const a = Number(y.split("/")[0]) + 1; return `${a}/${String(a + 1).slice(-2)}`; };
const _r2 = (x) => Math.round(x * 100) / 100;
const _r4 = (x) => Math.round(x * 1e4) / 1e4;
export function optimiseDisposals({ holdings, startYear, years = 10, income = 0, useBasicBand = false, growth = 0, mode = "selldown", objective = "gain" }) {
  const wash = mode === "wash";
  let hs = holdings.map((h) => ({ ticker: h.ticker, qty: +h.qty, avgCost: +h.qty ? +h.cost / +h.qty : 0, price: +h.price })).filter((h) => h.qty > 0 && isFinite(h.price) && h.price > 0);
  const embedded = () => hs.reduce((s, h) => s + Math.max(0, h.qty * (h.price - h.avgCost)), 0);
  const heldQty = () => hs.reduce((s, h) => s + h.qty, 0);
  // Market value of the holdings that still carry a gain — the meaningful
  // "left to sell down" figure (summing raw units across different securities
  // would be nonsense — a share of a £2 line ≠ a share of a £900 line).
  const appreciatedValue = () => hs.reduce((s, h) => s + ((h.price - h.avgCost) > 1e-9 ? h.qty * h.price : 0), 0);
  // Band room at the start year (income constant across the horizon) — lets
  // the caller show whether the 18% toggle can do anything at all.
  const startCfg = cfgFor(startYear);
  const bandRoomStart = Math.max(0, startCfg.basicLimit - Math.max(0, income - paFor(startCfg.pa, income)));
  const startEmbedded = embedded(); const schedule = [];
  let y = startYear, totalRealised = 0, totalProceeds = 0, totalTax = 0, yearsToClear = null;
  for (let i = 0; i < years; i++) {
    const cfg = cfgFor(y); const pa = paFor(cfg.pa, income); const taxableIncome = Math.max(0, income - pa);
    const bandRoom = Math.max(0, cfg.basicLimit - taxableIncome);
    const basicRate = cfg.rates[cfg.rates.length - 1].basic; // 18% on non-property in current bands
    const gainBudget = cfg.aea + (useBasicBand ? bandRoom : 0);
    let budgetLeft = gainBudget, realised = 0, proceeds = 0; const sells = [];
    // Order the lots per the objective (see header): "cash" spends the
    // allowance on the lowest gain-per-share lots (most proceeds), "gain" on
    // the highest (fewest shares, most units retained).
    const order = hs.map((h, idx) => ({ idx, gps: h.price - h.avgCost })).filter((o) => o.gps > 1e-9 && hs[o.idx].qty > 1e-9)
      .sort((a, b) => objective === "cash" ? a.gps - b.gps : b.gps - a.gps);
    for (const { idx } of order) {
      if (budgetLeft <= 1e-6) break; const h = hs[idx], gps = h.price - h.avgCost;
      const takeGain = Math.min(h.qty * gps, budgetLeft); const shares = takeGain / gps; // shares <= h.qty always
      if (shares <= 1e-9) continue;            // nothing left to sell in this lot — don't emit a phantom 0-share row
      if (!wash) proceeds += shares * h.price; // cash only when we don't rebuy
      realised += takeGain; budgetLeft -= takeGain;
      if (wash) h.avgCost = ((h.qty - shares) * h.avgCost + shares * h.price) / h.qty; // keep qty, lift base cost
      else h.qty = Math.max(0, h.qty - shares);                                         // sell down — never below 0
      sells.push({ ticker: h.ticker, shares: _r4(shares), gain: _r2(takeGain), proceeds: _r2(shares * h.price) });
    }
    const aeaUsed = Math.min(realised, cfg.aea); const bandGain = Math.max(0, realised - cfg.aea);
    const tax = _r2(bandGain * basicRate); // band gain is always within the 18% room (budget was capped there)
    totalRealised += realised; totalProceeds += proceeds; totalTax += tax;
    const remaining = embedded();
    schedule.push({ year: y, aea: cfg.aea, bandRoom: _r2(bandRoom), gainBudget: _r2(gainBudget),
      gainRealised: _r2(realised), proceeds: _r2(proceeds), aeaUsed: _r2(aeaUsed), bandGain: _r2(bandGain), tax, sells,
      remainingValue: _r2(appreciatedValue()),
      cumulativeRealised: _r2(totalRealised), cumulativeProceeds: _r2(totalProceeds),
      remainingUnrealised: _r2(remaining), remainingQty: _r4(heldQty()) });
    if (remaining <= 1e-6 && yearsToClear == null) yearsToClear = i + 1;
    if (remaining <= 1e-6) break;
    if (growth) for (const h of hs) h.price *= 1 + growth; y = nextTaxYear(y);
  }
  return { mode, objective, schedule, yearsToClear, bandRoomStart: _r2(bandRoomStart),
    totalRealised: _r2(totalRealised), totalProceeds: _r2(totalProceeds), totalTax: _r2(totalTax),
    startEmbedded: _r2(startEmbedded), remainingAfter: _r2(embedded()) };
}
