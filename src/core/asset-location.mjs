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

// Real trailing-income yield per security, from the dividend/interest ledger.
// yieldPct = trailing-`windowDays` income for a ticker ÷ its current market
// value (aggregated across every wrapper — yield is a property of the security,
// not where it's held). incomeKind is whichever of interest/dividend dominates,
// so a bond fund that actually pays interest is taxed at interest rates even if
// its `kind` wasn't set. Feeds giaDragPct so holdings stop sharing a single
// kind-default figure once there's a payment history. Pure, node-tested.
export function yieldsByTicker({ incomeEntries = [], positions = [], today, windowDays = 365 } = {}) {
  if (!today) throw new Error("yieldsByTicker requires today");
  const cutoff = new Date(today); cutoff.setDate(cutoff.getDate() - windowDays);
  const cutISO = cutoff.toISOString().slice(0, 10);
  const mv = {};
  for (const p of positions) {
    if (!p.priced || !(p.marketValue > 0) || !p.ticker) continue;
    mv[p.ticker] = (mv[p.ticker] || 0) + p.marketValue;
  }
  const inc = {};
  for (const e of incomeEntries) {
    if (!e.date || !e.ticker || !e.amount || e.date < cutISO || e.date > today) continue;
    const o = inc[e.ticker] || (inc[e.ticker] = { div: 0, int: 0 });
    if (e.kind === "interest") o.int += +e.amount; else o.div += +e.amount;
  }
  const out = {};
  for (const [ticker, o] of Object.entries(inc)) {
    const value = mv[ticker];
    if (!(value > 0)) continue; // no live holding to divide by → can't form a yield
    const total = o.div + o.int;
    out[ticker] = { yieldPct: r2((total / value) * 100), incomeKind: o.int > o.div ? "interest" : "dividend" };
  }
  return out;
}

// Annual GIA tax drag, as a FRACTION of value, for one holding.
// Yield priority: an explicit secMeta.yieldPct (manual override) beats a real
// ledger-derived yield, which beats the kind default.
export function giaDragPct(position, secMeta = {}, rates, { realisationFactor = REALISATION_FACTOR, realYields = {}, kindAssumptions = null } = {}) {
  const meta = secMeta[position.ticker] || {};
  const real = realYields[position.ticker];
  const kind = position.kind || "fund";
  // The caller can supply user-overridden kind assumptions (core/assumptions.mjs);
  // otherwise the built-in defaults apply.
  const KA = kindAssumptions || KIND_ASSUMPTIONS;
  const a = KA[kind] || KA.fund || KIND_ASSUMPTIONS.fund;
  let yieldPct = Number.isFinite(+meta.yieldPct) ? +meta.yieldPct
    : (real && Number.isFinite(+real.yieldPct)) ? +real.yieldPct
    : a.incomeYield;
  // A gilt's income drag is its COUPON, not a generic 3.5% bond yield. A
  // low-coupon gilt held below par returns mostly CGT-exempt redemption
  // gain (s115 TCGA) and pays little interest, so its true GIA drag is
  // tiny — the 3.5% default wrongly flagged such gilts as worth sheltering
  // (3.5% × a 45% additional rate = 1.58% of phantom drag). Use the real
  // coupon when secMeta carries it.
  if (kind === "gilt" && Number.isFinite(+meta.coupon)) yieldPct = +meta.coupon;
  // Income type: real ledger data (does it actually pay interest or dividends?)
  // beats the kind assumption.
  const incomeKind = real && real.incomeKind ? real.incomeKind : a.incomeKind;
  const incomeRate = incomeKind === "interest" ? rates.interest : rates.dividend;
  const cgtExempt = a.cgtExempt || position.cgtExempt;
  const capitalDrag = cgtExempt ? 0 : (a.growth / 100) * rates.cgt * realisationFactor;
  return (yieldPct / 100) * incomeRate + capitalDrag;
}

export function locationPlan({ positions = [], secMeta = {}, income = 0, incomeEntries = [], today, kindAssumptions = null, realisationFactor = REALISATION_FACTOR } = {}) {
  const rates = marginalRates(income);
  const realYields = today ? yieldsByTicker({ incomeEntries, positions, today }) : {};
  const rows = [];
  for (const p of positions) {
    if (!p.priced || !(p.marketValue > 0)) continue;
    // VCTs are out of scope for asset location: their dividends are tax-free
    // and they can't be moved into an ISA/SIPP (and the 5-year relief clock
    // locks them anyway). Including them would show a phantom drag and, worse,
    // suggest sheltering something that's already tax-exempt.
    if (String(p.wrapper).toUpperCase() === "VCT") continue;
    const wrapper = p.wrapper;
    const dragPct = giaDragPct(p, secMeta, rates, { realYields, kindAssumptions, realisationFactor });
    const yieldSource = Number.isFinite(+(secMeta[p.ticker] || {}).yieldPct) ? "override"
      : realYields[p.ticker] ? "actual" : "assumed";
    rows.push({
      ticker: p.ticker, wrapper: p.wrapper, kind: p.kind, value: r2(p.marketValue),
      dragPct,
      dragGbp: r2(p.marketValue * dragPct),
      sheltered: SHELTERED.has(wrapper),
      yieldSource, // "override" | "actual" | "assumed" — how the income yield was sourced
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
