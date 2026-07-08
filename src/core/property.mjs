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

/* ------------------------------ valuation ----------------------------- */
// Estimated current value of a property: a manual override always wins
// (the user has looked at Rightmove/an agent and knows better); otherwise
// HPI-indexed from the purchase price using the cached {purchaseIndex,
// latestIndex} pulled from the Land Registry proxy (api/hpi.mjs); falling
// back to the raw purchase price ("cost", clearly flagged, not silently
// passed off as a live valuation) until that fetch has happened at least
// once.
export function estimatedPropertyValue(property = {}) {
  const { valuationMode, manualValue, manualValueAsOf, purchasePrice, hpi } = property;
  if (valuationMode === "manual" && Number.isFinite(+manualValue)) {
    return { value: +manualValue, method: "manual", asOf: manualValueAsOf || null };
  }
  if (hpi && Number.isFinite(+hpi.purchaseIndex) && Number.isFinite(+hpi.latestIndex) && +hpi.purchaseIndex > 0) {
    const value = (+purchasePrice || 0) * (+hpi.latestIndex / +hpi.purchaseIndex);
    return {
      value, method: "hpi", asOf: hpi.latestMonth || null,
      purchaseIndex: hpi.purchaseIndex, latestIndex: hpi.latestIndex,
      basisMonth: hpi.purchaseMonth || null, // actual HPI month used as the base — may differ from the purchase month if HPI history doesn't reach that far back (pre-1995 E&W, pre-2004 Scotland, pre-2005 NI)
    };
  }
  return { value: +purchasePrice || 0, method: "cost", asOf: null };
}

/* ------------------------------ mortgages ------------------------------ */
// No amortisation schedule is modelled: real payoff paths depend on
// overpayments and rate changes only the user knows, so the app stores the
// last-entered balance rather than projecting one — same "don't fabricate
// precision" principle used throughout (see gilts.mjs, returns.mjs XIRR
// gating). `balanceAsOf` carries the staleness signal instead.
export function mortgageBalance(mortgage = {}) {
  return { balance: +mortgage.balance || 0, asOf: mortgage.balanceAsOf || null };
}

export function propertyEquity(property, mortgages = []) {
  const { value, method, asOf } = estimatedPropertyValue(property);
  const linked = mortgages.filter((m) => m.propertyId === property.id);
  const debt = linked.reduce((s, m) => s + (+m.balance || 0), 0);
  return { value, method, asOf, debt, equity: value - debt, mortgageCount: linked.length };
}

export function netPropertyWorth(properties = [], mortgages = []) {
  let value = 0, debt = 0;
  const rows = properties.map((p) => {
    const eq = propertyEquity(p, mortgages);
    value += eq.value; debt += eq.debt;
    return { property: p, ...eq };
  });
  // Mortgages not linked to any registered property still count as debt —
  // e.g. entered before the property row existed, or a data-entry slip —
  // surfaced separately so nothing silently vanishes from the total.
  const linkedIds = new Set(properties.map((p) => p.id));
  const orphanMortgages = mortgages.filter((m) => !linkedIds.has(m.propertyId));
  const orphanDebt = orphanMortgages.reduce((s, m) => s + (+m.balance || 0), 0);
  return { rows, value, debt: debt + orphanDebt, equity: value - debt - orphanDebt, orphanMortgages };
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
