/* ======================================================================
   PROPERTY & LIABILITIES (Phase 2, build step 1) — completes the balance
   sheet: real estate, mortgages, and other debts, alongside the existing
   investment/cash wealth model (core/portfolio.mjs). Pure and React-free;
   runs under node --test (see property.test.mjs).

   Land Registry UK HPI region slugs verified by hand against the live
   API, 2026-07 (https://landregistry.data.gov.uk/app/ukhpi/download/new.csv,
   the same endpoint the site's own "browse" tool downloads from) — the 9
   official English regions plus the four home nations and the UK
   aggregate. Local-authority-level indexing (441+ areas) exists on the
   same service but isn't exposed here; picking the closest region is a
   reasonable approximation for a personal net-worth estimate, not a RICS
   survey or a substitute for an actual valuation.
   ====================================================================== */

export const HPI_REGIONS = [
  { slug: "north-east", label: "North East (England)" },
  { slug: "north-west", label: "North West (England)" },
  { slug: "yorkshire-and-the-humber", label: "Yorkshire and The Humber" },
  { slug: "east-midlands", label: "East Midlands" },
  { slug: "west-midlands", label: "West Midlands" },
  { slug: "east-of-england", label: "East of England" },
  { slug: "london", label: "London" },
  { slug: "south-east", label: "South East (England)" },
  { slug: "south-west", label: "South West (England)" },
  { slug: "england", label: "England" },
  { slug: "wales", label: "Wales" },
  { slug: "scotland", label: "Scotland" },
  { slug: "northern-ireland", label: "Northern Ireland" },
  { slug: "united-kingdom", label: "United Kingdom" },
];
export const regionLabel = (slug) => HPI_REGIONS.find((r) => r.slug === slug)?.label || slug || "—";

/* ------------------------------ currency / FX --------------------------- */
// Foreign (non-GBP) properties and mortgages carry `currency` plus a cached
// `fxRate`/`fxAsOf` — GBP per 1 unit of that currency, fetched client-side
// via the same /api/fx proxy the rest of the app uses (ui/shared.jsx's
// fxToGBP) and stored back on the record, so this module stays pure and
// network-free, the same pattern as the HPI `{purchaseIndex, latestIndex}`
// cache below. A record whose rate hasn't been fetched yet is NOT silently
// treated as 1:1 with GBP (that would misstate net worth) and NOT dropped
// from the total either (that would silently lose real value/debt) — it's
// excluded from the GBP figures and its id surfaced via `needsFx` so the
// gap is visible, not invented, mirroring how unpriced holdings are handled
// in portfolio.mjs and how ibkr-import.mjs flags rows needing FX.
export const FOREIGN_CURRENCIES = ["EUR"]; // extend here if another currency is needed later
function toGbp(amount, currency, fxRate) {
  const ccy = currency || "GBP";
  if (ccy === "GBP") return { gbp: amount, converted: true };
  if (Number.isFinite(+fxRate) && +fxRate > 0) return { gbp: amount * fxRate, converted: true };
  return { gbp: 0, converted: false };
}

/* ------------------------------ valuation ----------------------------- */
// Estimated current value of a property, in both its native currency and
// GBP: a manual override always wins (the user has looked at Rightmove/an
// agent and knows better); otherwise, for GBP properties only, HPI-indexed
// from the purchase price using the cached {purchaseIndex, latestIndex}
// pulled from the Land Registry proxy (api/hpi.mjs); falling back to the
// raw purchase price ("cost", clearly flagged, not silently passed off as a
// live valuation) until a value has been entered. HPI indexing is UK-only —
// the Land Registry index has no foreign coverage — so a non-GBP property
// is always manual/cost, never HPI-indexed, regardless of `valuationMode`.
export function estimatedPropertyValue(property = {}) {
  const { valuationMode, manualValue, manualValueAsOf, purchasePrice, hpi, currency, fxRate } = property;
  const ccy = currency || "GBP";
  let nativeValue, method, asOf, extra = {};
  if (valuationMode === "manual" && Number.isFinite(+manualValue)) {
    nativeValue = +manualValue; method = "manual"; asOf = manualValueAsOf || null;
  } else if (ccy === "GBP" && hpi && Number.isFinite(+hpi.purchaseIndex) && Number.isFinite(+hpi.latestIndex) && +hpi.purchaseIndex > 0) {
    nativeValue = (+purchasePrice || 0) * (+hpi.latestIndex / +hpi.purchaseIndex);
    method = "hpi"; asOf = hpi.latestMonth || null;
    // actual HPI month used as the base — may differ from the purchase month
    // if HPI history doesn't reach that far back (pre-1995 E&W, pre-2004
    // Scotland, pre-2005 NI)
    extra = { purchaseIndex: hpi.purchaseIndex, latestIndex: hpi.latestIndex, basisMonth: hpi.purchaseMonth || null };
  } else {
    nativeValue = +purchasePrice || 0; method = "cost"; asOf = null;
  }
  const { gbp, converted } = toGbp(nativeValue, ccy, fxRate);
  return {
    value: gbp, nativeValue, currency: ccy,
    fxConverted: converted, fxRate: ccy === "GBP" ? 1 : (Number.isFinite(+fxRate) ? +fxRate : null), fxAsOf: ccy === "GBP" ? null : (property.fxAsOf || null),
    method, asOf, ...extra,
  };
}

/* ------------------------------ mortgages ------------------------------ */
// No amortisation schedule is modelled: real payoff paths depend on
// overpayments and rate changes only the user knows, so the app stores the
// last-entered balance rather than projecting one — same "don't fabricate
// precision" principle used throughout (see gilts.mjs, returns.mjs XIRR
// gating). `balanceAsOf` carries the staleness signal instead. A foreign
// mortgage's balance is stored (and entered) in its own currency and
// converted to GBP the same way as a foreign property (see toGbp above).
export function mortgageBalance(mortgage = {}) {
  const ccy = mortgage.currency || "GBP";
  const nativeBalance = +mortgage.balance || 0;
  const { gbp, converted } = toGbp(nativeBalance, ccy, mortgage.fxRate);
  return {
    balance: gbp, nativeBalance, currency: ccy,
    fxConverted: converted, fxRate: ccy === "GBP" ? 1 : (Number.isFinite(+mortgage.fxRate) ? +mortgage.fxRate : null), fxAsOf: ccy === "GBP" ? null : (mortgage.fxAsOf || null),
    asOf: mortgage.balanceAsOf || null,
  };
}

export function propertyEquity(property, mortgages = []) {
  const v = estimatedPropertyValue(property);
  const linked = mortgages.filter((m) => m.propertyId === property.id);
  let debt = 0;
  const needsFxMortgages = [];
  for (const m of linked) {
    const mb = mortgageBalance(m);
    debt += mb.balance;
    if (!mb.fxConverted) needsFxMortgages.push(m.id);
  }
  return {
    value: v.value, nativeValue: v.nativeValue, currency: v.currency, fxConverted: v.fxConverted,
    method: v.method, asOf: v.asOf,
    debt, equity: v.value - debt, mortgageCount: linked.length, needsFxMortgages,
  };
}

export function netPropertyWorth(properties = [], mortgages = []) {
  let value = 0, debt = 0;
  const needsFx = []; // property ids whose native value couldn't be converted to GBP yet
  const rows = properties.map((p) => {
    const eq = propertyEquity(p, mortgages);
    value += eq.value; debt += eq.debt;
    if (!eq.fxConverted) needsFx.push(p.id);
    return { property: p, ...eq };
  });
  // Mortgages not linked to any registered property still count as debt —
  // e.g. entered before the property row existed, or a data-entry slip —
  // surfaced separately so nothing silently vanishes from the total.
  const linkedIds = new Set(properties.map((p) => p.id));
  const orphanMortgages = mortgages.filter((m) => !linkedIds.has(m.propertyId));
  let orphanDebt = 0;
  for (const m of orphanMortgages) { const mb = mortgageBalance(m); orphanDebt += mb.balance; if (!mb.fxConverted) needsFx.push(m.id); }
  return { rows, value, debt: debt + orphanDebt, equity: value - debt - orphanDebt, orphanMortgages, needsFx };
}

/* --------------------------- other liabilities -------------------------- */
export function totalOtherLiabilities(otherLiabilities = []) {
  return otherLiabilities.reduce((s, l) => s + (+l.balance || 0), 0);
}

/* ------------------------------ attention ------------------------------- */
// Fixed-rate mortgage deals ending soon (or already reverted to SVR) — the
// "needs attention" analogue of stale prices / unpriced holdings elsewhere.
// `today` is injected (ISO string), not read from Date.now(), so this stays
// pure and testable.
export function mortgagesEndingSoon(mortgages = [], today, withinDays = 180) {
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() + withinDays);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  return mortgages
    .filter((m) => m.rateType === "fixed" && m.fixedEndDate && m.fixedEndDate <= cutoffISO)
    .map((m) => ({ ...m, expired: m.fixedEndDate < today }))
    .sort((a, b) => (a.fixedEndDate < b.fixedEndDate ? -1 : 1));
}

/* ------------------------------ net worth -------------------------------- */
// The whole point: investments + cash (from the existing wealth model)
// plus property equity (mortgages already netted off inside it), minus
// any other, non-mortgage debts = true household net worth.
export function householdNetWorth({ investedTotal = 0, properties = [], mortgages = [], otherLiabilities = [] } = {}) {
  const prop = netPropertyWorth(properties, mortgages);
  const otherDebt = totalOtherLiabilities(otherLiabilities);
  return {
    investedTotal,
    propertyValue: prop.value,
    propertyDebt: prop.debt,
    propertyEquity: prop.equity,
    otherLiabilities: otherDebt,
    totalLiabilities: prop.debt + otherDebt,
    netWorth: investedTotal + prop.equity - otherDebt,
  };
}
