/* ======================================================================
   ASSET-LOCATION OPTIMISER — same portfolio, same wrappers, different
   PLACEMENT: which holdings should sit inside the ISA/SIPP shelter and
   which can live in the GIA, to minimise the annual tax drag of holding
   everything exactly as you do today.

   Model, stated plainly because every number here is an estimate:
   - Each holding gets an estimated ANNUAL GIA TAX DRAG per £ held:
       income yield × marginal rate on that income type
     + expected capital growth × CGT rate × a realisation factor.
   - Income yields default by instrument kind (overridable per security
     via secMeta[t].yieldPct — the Returns tab's income data is the
     better source when present, so callers can pass real yields in).
   - Interest is taxed at full marginal rates (worst), dividends at
     dividend rates, capital growth at CGT rates DISCOUNTED by a
     realisation factor (default 0.5: unrealised gains defer tax, and
     AEA/timing recover some of it — charging full CGT on paper growth
     every year would overstate the drag).
   - Individual gilts are CGT-EXEMPT (s115 TCGA): zero capital drag, and
     a low-coupon gilt has almost no income drag either — which is why
     they're often the RIGHT thing to hold unsheltered.
   - Allowances (dividend £500, PSA) are NOT netted per holding — they're
     portfolio-level and small; ignoring them overstates drag slightly
     and uniformly. Stated in the UI.

   The optimal placement given current capacities (total sheltered value
   = shelter capacity) is fractional-knapsack: sort by drag %, shelter
   from the top down. That yields the minimum achievable drag for the
   CURRENT portfolio and wrapper sizes; the saving is current − minimum.
   Moves happen via real-world mechanics (sell/rebuy, bed-and-ISA, new
   contributions) with their own CGT consequences — the suggestions say
   what to move, the Bed & ISA tab prices the move itself.
   Pure and node-tested (asset-location.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;

// Default annual income yield (%) and expected capital growth (%) by
// instrument kind — deliberately round, clearly assumptions.
export const KIND_ASSUMPTIONS = {
  equity: { incomeYield: 2.0, incomeKind: "dividend", growth: 5.0 },
  fund: { incomeYield: 2.0, incomeKind: "dividend", growth: 5.0 },
  investment_trust: { incomeYield: 3.5, incomeKind: "dividend", growth: 4.0 },
  gilt: { incomeYield: 3.5, incomeKind: "interest", growth: 0, cgtExempt: true },
  bond_fund: { incomeYield: 4.0, incomeKind: "interest", growth: 0.5 },
};
export const REALISATION_FACTOR = 0.5;

// Marginal rates from taxable income (salary etc), 2026/27 bands (rUK).
export function marginalRates(income = 0) {
  const higher = income > 50270, additional = income > 125140;
  return {
    dividend: additional ? 0.3935 : higher ? 0.3375 : 0.0875,
    interest: additional ? 0.45 : higher ? 0.40 : 0.20,
    cgt: higher || additional ? 0.24 : 0.18,
  };
}

const SHELTERED = new Set(["ISA", "SIPP", "LISA"]);

// Annual GIA tax drag, as a FRACTION of value, for one holding.
export function giaDragPct(position, secMeta = {}, rates, { realisationFactor = REALISATION_FACTOR } = {}) {
  const meta = secMeta[position.ticker] || {};
  const kind = position.kind || "fund";
  const a = KIND_ASSUMPTIONS[kind] || KIND_ASSUMPTIONS.fund;
  const yieldPct = Number.isFinite(+meta.yieldPct) ? +meta.yieldPct : a.incomeYield;
  const incomeRate = a.incomeKind === "interest" ? rates.interest : rates.dividend;
  const cgtExempt = a.cgtExempt || position.cgtExempt;
  const capitalDrag = cgtExempt ? 0 : (a.growth / 100) * rates.cgt * realisationFactor;
  return (yieldPct / 100) * incomeRate + capitalDrag;
}

export function locationPlan({ positions = [], secMeta = {}, income = 0 } = {}) {
  const rates = marginalRates(income);
  const rows = [];
  for (const p of positions) {
    if (!p.priced || !(p.marketValue > 0)) continue;
    const wrapper = p.wrapper === "VCT" ? "GIA" : p.wrapper; // VCT is its own shelter; treat as unshelterable
    const dragPct = giaDragPct(p, secMeta, rates);
    rows.push({
      ticker: p.ticker, wrapper: p.wrapper, kind: p.kind, value: r2(p.marketValue),
      dragPct,
      dragGbp: r2(p.marketValue * dragPct),
      sheltered: SHELTERED.has(wrapper),
    });
  }
  if (!rows.length) return { rows: [], currentDrag: 0, minimalDrag: 0, savingPerYear: 0, moves: [], rates };

  const currentDrag = r2(rows.filter((r) => !r.sheltered).reduce((s, r) => s + r.dragGbp, 0));
  const shelterCapacity = rows.filter((r) => r.sheltered).reduce((s, r) => s + r.value, 0);

  // Fractional knapsack: shelter the highest-drag value first.
  const byDrag = [...rows].sort((a, b) => b.dragPct - a.dragPct);
  let cap = shelterCapacity, minimalDrag = 0;
  const optimallySheltered = new Map(); // ticker|wrapper -> sheltered fraction of value
  for (const r of byDrag) {
    const inside = Math.min(r.value, cap);
    cap -= inside;
    minimalDrag += (r.value - inside) * r.dragPct;
    optimallySheltered.set(`${r.ticker}|${r.wrapper}`, r.value > 0 ? inside / r.value : 0);
  }
  minimalDrag = r2(minimalDrag);

  // Concrete moves: unsheltered rows that should be (mostly) inside, and
  // sheltered rows that optimally sit (mostly) outside — paired by the
  // user, priced by the Bed & ISA tab.
  const shelterThese = rows
    .filter((r) => !r.sheltered && (optimallySheltered.get(`${r.ticker}|${r.wrapper}`) || 0) > 0.5)
    .sort((a, b) => b.dragGbp - a.dragGbp)
    .map((r) => ({ ...r, direction: "shelter" }));
  const releaseThese = rows
    .filter((r) => r.sheltered && (optimallySheltered.get(`${r.ticker}|${r.wrapper}`) || 0) < 0.5)
    .sort((a, b) => a.dragPct - b.dragPct)
    .map((r) => ({ ...r, direction: "release" }));

  return {
    rows: rows.sort((a, b) => b.dragGbp - a.dragGbp),
    rates,
    currentDrag,
    minimalDrag,
    savingPerYear: r2(Math.max(0, currentDrag - minimalDrag)),
    moves: [...shelterThese, ...releaseThese],
  };
}
