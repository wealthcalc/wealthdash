/* ======================================================================
   GILT PORTFOLIO ANALYTICS — the ladder as ONE instrument.

   gilts.mjs prices and yields each gilt on its own. This module answers
   the questions that only make sense across the whole ladder, plus the
   per-holding figures that a hold-to-maturity investor actually decides
   on. Pure and node-tested (gilt-portfolio.test.mjs).

   PORTFOLIO YIELD TO MATURITY
     Solve one XIRR: pay today's total dirty value, receive every projected
     coupon and redemption on its own date. That IS the yield to maturity
     of the ladder held to the end — not a value-weighted average of the
     individual GRYs, which ignores that a 2-year 4% gilt and a 20-year 4%
     gilt are not the same 4%. The weighted average is still reported as a
     cross-check (they agree closely on a flat curve).
     Basis follows the tab's toggle: "cash" flows give a NOMINAL yield
     (linker flows projected at the plan's inflation), "real" flows give a
     REAL yield (conventional flows deflated, linkers at the ratio already
     earned). Either way the figure is labelled with what went in.

   NET (AFTER-TAX) REDEMPTION YIELD
     The UK reason to own a low-coupon gilt: the coupon is taxable savings
     income in a GIA, the pull to par is CGT-free (TCGA 1992 s115). So a
     0.375% gilt at 84 and a 4.5% gilt at 101 can share a GROSS yield and
     differ by over a percentage point NET. Coupons are taxed at the
     marginal savings rate; redemption is untouched; sheltered wrappers
     pay nothing. The marginal rate is derived from the stored salary via
     the income-tax engine, and overridable.

   DURATION
     Macaulay duration = PV-weighted average time to each cashflow;
     modified = Macaulay / (1 + y/2) under the semi-annual convention. The
     useful reading is "£ lost per +1% in yields": modified × dirty value.
     It is NOT the same as years-to-maturity — a 4% 10-year has a duration
     nearer 8.

   YIELD ON COST
     The yield LOCKED IN when each purchase was made — GRY at the trade
     date and price actually paid — nominal-weighted across BUYs. The live
     GRY tells you what a buyer today gets; this tells you what you got.
     For a linker the purchase price on the ledger is cash (uplifted by the
     ratio on the day) and historic ratios aren't kept, so today's ratio is
     used and the figure is flagged approximate.

   REMAINING RETURN
     Cash to come (coupons + redemption) minus what the holding is worth
     today, split into coupon income (taxable unsheltered) and capital
     pull-to-par (tax-free). Accrued interest already paid for comes back
     in the next coupon, so it's netted out of the coupon side.
   ====================================================================== */

import { MS, dUTC } from "./cgt-engine.mjs";
import { xirr } from "./returns.mjs";
import { accruedPer100, projectCashflows, grossRedemptionYield } from "./gilts.mjs";

const EPS = 1e-9;
const daysBetween = (a, b) => Math.round((dUTC(b) - dUTC(a)) / MS);
export const yearsBetween = (a, b) => daysBetween(a, b) / 365.25;
const fin = (x) => Number.isFinite(x);
const semi = (r) => (r == null ? null : 2 * (Math.sqrt(1 + r) - 1));

const TAXABLE_WRAPPERS = new Set(["GIA"]);
export const isTaxableWrapper = (w) => TAXABLE_WRAPPERS.has(String(w || "GIA").toUpperCase());

/* ----------------------------- duration ------------------------------ */
// Per £100 nominal from a CLEAN price (real for a linker — the ratio
// cancels), at a settlement date. Uses the same flow set as the GRY, so a
// gilt in its ex-div window drops the next coupon on both sides.
export function duration(gilt, clean100, settlementISO) {
  if (!gilt || !fin(+clean100) || settlementISO >= gilt.maturity) return { macaulay: null, modified: null, dirty: null };
  const gry = grossRedemptionYield(gilt, clean100, settlementISO);
  if (gry.effectiveAnnual == null) return { macaulay: null, modified: null, dirty: gry.dirty ?? null, reason: gry.reason };
  const ai = accruedPer100(gilt, settlementISO);
  const r = gry.effectiveAnnual;
  let pv = 0, tpv = 0;
  for (const f of projectCashflows({ ...gilt, indexLinked: false }, 100, settlementISO)) {
    if (f.type === "coupon" && ai.exDiv && f.date === ai.next) continue;
    const t = daysBetween(settlementISO, f.date) / 365;
    const p = f.amount / (1 + r) ** t;
    pv += p; tpv += t * p;
  }
  if (!(pv > EPS)) return { macaulay: null, modified: null, dirty: gry.dirty };
  const macaulay = tpv / pv;
  const modified = macaulay / (1 + gry.semiAnnual / 2);
  return { macaulay, modified, dirty: gry.dirty, gry: gry.semiAnnual };
}

/* --------------------------- net redemption yield -------------------- */
// Coupons × (1 − rate), redemption untouched. rate is a decimal (0.4). A
// sheltered wrapper is the caller's business — pass 0.
export function netRedemptionYield(gilt, clean100, settlementISO, rate = 0) {
  if (!gilt || !fin(+clean100) || settlementISO >= gilt.maturity) return { effectiveAnnual: null, semiAnnual: null };
  if (!(rate > 0)) { const g = grossRedemptionYield(gilt, clean100, settlementISO); return { effectiveAnnual: g.effectiveAnnual, semiAnnual: g.semiAnnual, rate: 0, real: !!gilt.indexLinked }; }
  const ai = accruedPer100(gilt, settlementISO);
  const flows = [{ date: settlementISO, amount: -(+clean100 + ai.accrued) }];
  for (const f of projectCashflows({ ...gilt, indexLinked: false }, 100, settlementISO)) {
    if (f.type === "coupon" && ai.exDiv && f.date === ai.next) continue;
    flows.push({ date: f.date, amount: f.type === "coupon" ? f.amount * (1 - rate) : f.amount });
  }
  const r = xirr(flows);
  return { effectiveAnnual: r.rate, semiAnnual: semi(r.rate), rate, real: !!gilt.indexLinked, reason: r.reason };
}

// Marginal rate on the NEXT £ of savings interest, from any tax engine
// shaped like investmentIncomeTax. Probed with £100 so allowance edges
// (PSA, starting rate) show up as the blended figure they really are.
export function marginalSavingsRate(taxFn, { salary = 0, interest = 0, year } = {}) {
  if (typeof taxFn !== "function") return null;
  try {
    const a = taxFn({ salary, interest, dividends: 0, year }).interestTax || 0;
    const b = taxFn({ salary, interest: interest + 100, dividends: 0, year }).interestTax || 0;
    const r = (b - a) / 100;
    return fin(r) ? Math.max(0, Math.min(0.6, Math.round(r * 1000) / 1000)) : null;
  } catch { return null; }
}

/* ------------------------------ yield on cost ------------------------ */
// rows: this ticker's ledger rows (any wrapper). Each BUY's clean price is
// recovered from what was recorded — nativeAmount (clean consideration,
// what buildGiltTrade writes), else gbpAmount less fees. Nominal-weighted
// across BUYs; SELLs are ignored (what you sold no longer has a yield).
export function yieldOnCost(gilt, rows = []) {
  let wsum = 0, ysum = 0, n = 0;
  const approx = !!gilt?.indexLinked;
  const ratio = approx && fin(+gilt.indexRatio) && +gilt.indexRatio > 0 ? +gilt.indexRatio : 1;
  for (const t of rows) {
    if (!t || t.side !== "BUY" || !(+t.quantity > 0) || !t.date || t.date >= gilt.maturity) continue;
    const gbpNative = !t.nativeCurrency || String(t.nativeCurrency).toUpperCase() === "GBP";
    const consideration = gbpNative && fin(+t.nativeAmount) && +t.nativeAmount > 0 ? +t.nativeAmount : (+t.gbpAmount || 0) - (+t.fees || 0);
    if (!(consideration > 0)) continue;
    const clean100 = ((consideration / +t.quantity) * 100) / ratio;
    if (!(clean100 > 5 && clean100 < 300)) continue;   // not a per-£100 price — skip rather than poison the average
    const g = grossRedemptionYield(gilt, clean100, t.date);
    if (g.semiAnnual == null) continue;
    wsum += +t.quantity; ysum += g.semiAnnual * +t.quantity; n++;
  }
  if (!n) return { semiAnnual: null, purchases: 0, approx };
  return { semiAnnual: ysum / wsum, purchases: n, nominal: wsum, approx, real: !!gilt?.indexLinked };
}

/* ---------------------------- per-holding pack ----------------------- */
// Everything the table needs beyond giltAnalytics' holding row.
// `rows` = this ticker's ledger rows; `taxRate` = marginal savings rate.
export function holdingExtras(h, { asOf, rows = [], taxRate = 0 } = {}) {
  const gilt = { coupon: h.coupon, maturity: h.maturity, indexLinked: h.indexLinked, indexRatio: h.indexRatio };
  const clean = h.realClean100;
  const taxable = isTaxableWrapper(h.wrapper);
  const dur = h.matured || clean == null ? { macaulay: null, modified: null } : duration(gilt, clean, asOf);
  const net = h.matured || clean == null ? { semiAnnual: null } : netRedemptionYield(gilt, clean, asOf, taxable ? taxRate : 0);
  const yoc = yieldOnCost(gilt, rows);
  const years = h.matured ? 0 : yearsBetween(asOf, h.maturity);
  // Remaining return, cash basis (what will actually arrive).
  const flows = h.nominal > EPS && !h.matured ? projectCashflows(gilt, h.nominal, asOf, { inflation: 0 }) : [];
  const coupons = flows.filter((f) => f.type === "coupon").reduce((s, f) => s + f.amount, 0);
  const redemption = flows.filter((f) => f.type === "redemption").reduce((s, f) => s + f.amount, 0);
  const cleanValue = h.clean100 != null ? (h.clean100 * h.nominal) / 100 : null;
  const remaining = cleanValue == null ? null : {
    coupons: coupons - (h.accruedValue || 0),
    capital: redemption - cleanValue,
    total: coupons + redemption - (h.dirtyValue ?? cleanValue + (h.accruedValue || 0)),
    taxable,
  };
  return {
    yearsToMaturity: years,
    duration: dur,
    // £ change in this holding's value for a +1 percentage point move in yields.
    valuePer1pct: dur.modified != null && h.dirtyValue != null ? -(dur.modified * h.dirtyValue) / 100 : null,
    netYield: net,
    taxRateApplied: taxable ? taxRate : 0,
    yieldOnCost: yoc,
    remaining,
  };
}

/* ----------------------------- portfolio ----------------------------- */
// holdings + cashflows straight from giltAnalytics(). `field` chooses the
// basis (see header). `taxRate` gives the net figure alongside the gross.
export function portfolioYield({ holdings = [], cashflows = [], asOf, field = "amount", taxRate = 0 } = {}) {
  const live = holdings.filter((h) => h.nominal > EPS && !h.matured);
  const priced = live.filter((h) => h.dirtyValue != null);
  const unpriced = live.filter((h) => h.dirtyValue == null).map((h) => h.ticker);
  const keys = new Set(priced.map((h) => `${h.wrapper} ${h.ticker}`));
  const totalDirty = priced.reduce((s, h) => s + h.dirtyValue, 0);
  const totalAccrued = priced.reduce((s, h) => s + (h.accruedValue || 0), 0);
  const empty = { semiAnnual: null, effectiveAnnual: null, netSemiAnnual: null, totalDirty, unpriced, count: priced.length };
  if (!(totalDirty > EPS)) return { ...empty, reason: "nothing priced" };

  const flows = [{ date: asOf, amount: -totalDirty }];
  const netFlows = [{ date: asOf, amount: -totalDirty }];
  let coupons = 0, redemptions = 0, lastDate = asOf;
  for (const f of cashflows) {
    if (!keys.has(`${f.wrapper} ${f.ticker}`) || !(f.date > asOf)) continue;
    const v = +(f[field] ?? f.amount);
    if (!fin(v)) continue;
    flows.push({ date: f.date, amount: v });
    const taxed = f.type === "coupon" && isTaxableWrapper(f.wrapper) && taxRate > 0;
    netFlows.push({ date: f.date, amount: taxed ? v * (1 - taxRate) : v });
    if (f.type === "coupon") coupons += v; else redemptions += v;
    if (f.date > lastDate) lastDate = f.date;
  }
  const g = xirr(flows), n = xirr(netFlows);

  // Cross-checks and risk. Weighted GRY only over conventional holdings
  // (a real yield can't be averaged with a nominal one); duration over all.
  let wGry = 0, wGryW = 0, dv = 0, wDur = 0, wDurW = 0, wMat = 0;
  for (const h of priced) {
    const gilt = { coupon: h.coupon, maturity: h.maturity, indexLinked: h.indexLinked, indexRatio: h.indexRatio };
    if (!h.indexLinked && h.gry?.semiAnnual != null) { wGry += h.gry.semiAnnual * h.dirtyValue; wGryW += h.dirtyValue; }
    const d = h.realClean100 != null ? duration(gilt, h.realClean100, asOf) : { modified: null };
    if (d.modified != null) { dv += (d.modified * h.dirtyValue) / 100; wDur += d.modified * h.dirtyValue; wDurW += h.dirtyValue; }
    wMat += yearsBetween(asOf, h.maturity) * h.dirtyValue;
  }
  const anyIL = priced.some((h) => h.indexLinked), anyConv = priced.some((h) => !h.indexLinked);
  return {
    ...empty,
    effectiveAnnual: g.rate ?? null,
    semiAnnual: semi(g.rate),
    netSemiAnnual: semi(n.rate),
    taxRate,
    field,
    // What the headline number IS: nominal when built from cash flows of a
    // conventional-only ladder; real when built from real flows; "mixed"
    // when cash flows include linker projections (nominal, but resting on
    // the inflation assumption).
    kind: field === "realAmount" ? "real" : anyIL ? "nominal-projected" : "nominal",
    anyIndexLinked: anyIL, anyConventional: anyConv,
    weightedGry: wGryW > 0 ? wGry / wGryW : null,
    modifiedDuration: wDurW > 0 ? wDur / wDurW : null,
    valuePer1pct: wDurW > 0 ? -dv : null,
    weightedMaturityYears: totalDirty > 0 ? wMat / totalDirty : null,
    finalMaturity: lastDate,
    totalDirty, totalAccrued,
    cashToCome: coupons + redemptions,
    coupons, redemptions,
    remainingGain: coupons + redemptions - totalDirty,
    taxableCoupons: cashflows.filter((f) => keys.has(`${f.wrapper} ${f.ticker}`) && f.date > asOf && f.type === "coupon" && isTaxableWrapper(f.wrapper)).reduce((s, f) => s + (+(f[field] ?? f.amount) || 0), 0),
  };
}

/* --------------------------- maturity profile ------------------------ */
// Coupons and redemptions by calendar year — the ladder as a picture.
export function maturityProfile(cashflows = [], field = "amount") {
  const by = new Map();
  for (const f of cashflows) {
    if (!f || !f.date) continue;
    const v = +(f[field] ?? f.amount);
    if (!fin(v)) continue;
    const y = +f.date.slice(0, 4);
    if (!by.has(y)) by.set(y, { year: y, coupons: 0, redemptions: 0, total: 0, redeeming: [] });
    const r = by.get(y);
    if (f.type === "redemption") { r.redemptions += v; if (f.ticker && !r.redeeming.includes(f.ticker)) r.redeeming.push(f.ticker); } else r.coupons += v;
    r.total += v;
  }
  const years = [...by.keys()].sort((a, b) => a - b);
  if (!years.length) return [];
  const out = [];
  for (let y = years[0]; y <= years[years.length - 1]; y++) out.push(by.get(y) || { year: y, coupons: 0, redemptions: 0, total: 0, redeeming: [] });
  return out;
}

/* ------------------------------ yield curve -------------------------- */
// From the DMO catalogue (shapeGiltCatalogue rows): every priced,
// supported gilt's GRY against its maturity. Conventional and index-linked
// are returned in separate series — one is nominal, the other real, and
// putting them on one axis would invite the wrong comparison.
export function yieldCurvePoints(rows = [], asOf) {
  const conventional = [], indexLinked = [];
  for (const r of rows) {
    if (!r || !r.supported || !fin(+r.clean) || !r.maturity || r.maturity <= asOf) continue;
    const gilt = { coupon: +r.coupon, maturity: r.maturity, indexLinked: !!r.indexLinked };
    const g = grossRedemptionYield(gilt, +r.clean, asOf);
    if (g.semiAnnual == null) continue;
    const pt = { isin: r.isin, name: r.name, coupon: +r.coupon, maturity: r.maturity, years: yearsBetween(asOf, r.maturity), gry: g.semiAnnual, clean: +r.clean, cashClean: r.cashClean ?? +r.clean, indexLinked: !!r.indexLinked, rump: !!r.rump };
    (r.indexLinked ? indexLinked : conventional).push(pt);
  }
  const byYears = (a, b) => a.years - b.years;
  return { conventional: conventional.sort(byYears), indexLinked: indexLinked.sort(byYears) };
}

// Where a ladder falls short of the target, which gilts on the DMO list
// mature in that year, and roughly how much nominal would close the gap.
// The nominal needed treats redemption at par plus the final half-coupon
// as the year's cash (a linker's future uplift is ignored — conservative,
// and flagged). Costs use today's cash clean price; accrued is extra.
export function gapSuggestions({ ladderRows = [], curve = { conventional: [], indexLinked: [] }, maxPerYear = 3 } = {}) {
  const all = [...curve.conventional, ...curve.indexLinked];
  const out = [];
  for (const row of ladderRows) {
    if (!row || row.covered || !(row.surplus < 0)) continue;
    const shortfall = -row.surplus;
    const cands = all.filter((p) => +p.maturity.slice(0, 4) === +row.year && !p.rump)
      .map((p) => {
        const nominal = Math.ceil(shortfall / (1 + p.coupon / 200) / 100) * 100;
        return { ...p, nominal, cost: (nominal * p.cashClean) / 100 };
      })
      .sort((a, b) => b.gry - a.gry)
      .slice(0, maxPerYear);
    out.push({ year: row.year, shortfall, candidates: cands });
  }
  return out;
}
