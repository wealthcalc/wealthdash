import { test } from "node:test";
import assert from "node:assert/strict";
import { locationPlan, giaDragPct, marginalRates, KIND_ASSUMPTIONS, yieldsByTicker } from "../core/asset-location.mjs";

const pos = (ticker, wrapper, marketValue, kind, extra = {}) => ({ ticker, wrapper, marketValue, kind, priced: true, ...extra });

test("marginal rates by band", () => {
  assert.deepEqual(marginalRates(30000), { dividend: 0.0875, interest: 0.20, cgt: 0.18 });
  assert.deepEqual(marginalRates(90000), { dividend: 0.3375, interest: 0.40, cgt: 0.24 });
  assert.equal(marginalRates(200000).interest, 0.45);
});

test("drag ordering for a higher-rate taxpayer: bond funds > par gilts > equity funds; low-coupon gilts cheapest", () => {
  const rates = marginalRates(90000);
  const bond = giaDragPct(pos("BND", "GIA", 1, "bond_fund"), {}, rates);       // 4%×40% + 0.5%×24%×0.5 = 1.66%
  const eq = giaDragPct(pos("VWRL", "GIA", 1, "fund"), {}, rates);             // 2%×33.75% + 5%×24%×0.5 = 1.275%
  const gilt = giaDragPct(pos("TN28", "GIA", 1, "gilt"), {}, rates);           // 3.5%×40% = 1.40% (CGT-exempt)
  const lowGilt = giaDragPct(pos("TN31", "GIA", 1, "gilt"), { TN31: { yieldPct: 0.25 } }, rates); // 0.10%
  assert.ok(bond > gilt && gilt > eq, `expected bond ${bond} > gilt ${gilt} > equity fund ${eq}`);
  assert.ok(lowGilt < eq, "the LOW-COUPON gilt is the classic cheap-to-hold-outside asset");
  // gilt drag = coupon × interest rate only (no capital term — s115 exempt)
  assert.ok(Math.abs(gilt - (KIND_ASSUMPTIONS.gilt.incomeYield / 100) * rates.interest) < 1e-12);
});

test("secMeta yieldPct overrides the kind default", () => {
  const rates = marginalRates(90000);
  const low = giaDragPct(pos("TN31", "GIA", 1, "gilt"), { TN31: { yieldPct: 0.25 } }, rates);
  assert.ok(Math.abs(low - 0.0025 * 0.40) < 1e-12); // low-coupon gilt: near-zero drag
});

test("plan: shelters the highest-drag assets first and quantifies the saving", () => {
  // Genuinely backwards: a near-zero-drag low-coupon gilt hogs the ISA
  // while the high-drag bond fund sits taxable.
  const plan = locationPlan({
    positions: [
      pos("BND", "GIA", 100000, "bond_fund"),
      pos("TN31", "ISA", 100000, "gilt"),
    ],
    secMeta: { TN31: { yieldPct: 0.25 } },
    income: 90000,
  });
  assert.ok(plan.currentDrag > plan.minimalDrag);
  assert.ok(plan.savingPerYear > 0);
  // shelter the bond fund; the low-coupon gilt is the classic release
  assert.deepEqual(plan.moves.map((m) => [m.ticker, m.direction]), [["BND", "shelter"], ["TN31", "release"]]);
  // saving ≈ (1.66% − 0.10%) × £100k
  assert.ok(Math.abs(plan.savingPerYear - (0.0166 - 0.001) * 100000) < 1);
});

test("an already-optimal portfolio reports ~zero saving and no moves", () => {
  const plan = locationPlan({
    positions: [
      pos("BND", "SIPP", 100000, "bond_fund"),                 // highest drag, sheltered
      pos("TN31", "GIA", 100000, "gilt"),                       // cheapest, outside
    ],
    secMeta: { TN31: { yieldPct: 0.25 } },
    income: 90000,
  });
  assert.ok(plan.savingPerYear < 0.01, String(plan.savingPerYear));
  assert.equal(plan.moves.length, 0);
});

test("VCTs are excluded from asset location — tax-free income, can't be sheltered", () => {
  const plan = locationPlan({
    positions: [pos("GHV", "VCT", 50000, "investment_trust"), pos("VWRL", "GIA", 10000, "fund")],
    income: 90000,
  });
  assert.ok(!plan.rows.some((r) => r.ticker === "GHV"), "the VCT is not in the drag table");
  assert.ok(plan.rows.some((r) => r.ticker === "VWRL"), "ordinary GIA holdings still appear");
  // its value must not count as shelter capacity or drag
  assert.equal(plan.rows.length, 1);
});

test("no shelter capacity -> minimal equals current, everything stays put", () => {
  const plan = locationPlan({ positions: [pos("VWRL", "GIA", 50000, "fund")], income: 30000 });
  assert.equal(plan.currentDrag, plan.minimalDrag);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.savingPerYear, 0);
});

test("yieldsByTicker: trailing-12m income ÷ market value, income kind from what actually paid", () => {
  const TODAY = "2026-07-24";
  const incomeEntries = [
    { date: "2025-09-01", ticker: "CTY", amount: 150, kind: "dividend" },
    { date: "2026-03-01", ticker: "CTY", amount: 150, kind: "dividend" },
    { date: "2024-01-01", ticker: "CTY", amount: 999, kind: "dividend" }, // >12m ago, ignored
    { date: "2026-02-01", ticker: "BND", amount: 400, kind: "interest" },
  ];
  const positions = [
    { ticker: "CTY", wrapper: "ISA", marketValue: 10000, priced: true },
    { ticker: "CTY", wrapper: "GIA", marketValue: 5000, priced: true }, // aggregated across wrappers
    { ticker: "BND", wrapper: "GIA", marketValue: 10000, priced: true },
  ];
  const y = yieldsByTicker({ incomeEntries, positions, today: TODAY });
  assert.equal(y.CTY.yieldPct, 2);          // £300 / £15,000
  assert.equal(y.CTY.incomeKind, "dividend");
  assert.equal(y.BND.yieldPct, 4);          // £400 / £10,000
  assert.equal(y.BND.incomeKind, "interest");
});

test("yieldsByTicker: no live holding → no yield (can't divide), requires today", () => {
  assert.deepEqual(yieldsByTicker({ incomeEntries: [{ date: "2026-01-01", ticker: "X", amount: 100 }], positions: [], today: "2026-07-24" }), {});
  assert.throws(() => yieldsByTicker({ incomeEntries: [], positions: [] }), /today/);
});

test("real ledger yield overrides the kind default, but a manual secMeta.yieldPct still wins", () => {
  const rates = marginalRates(90000);
  const p = { ticker: "ABC", kind: "fund", marketValue: 10000, priced: true };
  // fund default is 2% dividend; real ledger shows 5%
  const real = { ABC: { yieldPct: 5, incomeKind: "dividend" } };
  const dflt = giaDragPct(p, {}, rates);
  const withReal = giaDragPct(p, {}, rates, { realYields: real });
  assert.ok(withReal > dflt, "a higher real yield lifts the drag above the 2% default");
  // manual override beats the real figure
  const withManual = giaDragPct(p, { ABC: { yieldPct: 1 } }, rates, { realYields: real });
  assert.ok(withManual < dflt, "manual 1% yield beats both the default and the real 5%");
});

test("locationPlan tags each row's yield source and uses real yields when today+income given", () => {
  const plan = locationPlan({
    positions: [
      { ticker: "REAL", wrapper: "GIA", marketValue: 10000, kind: "fund", priced: true },
      { ticker: "NONE", wrapper: "GIA", marketValue: 10000, kind: "fund", priced: true },
      { ticker: "MAN", wrapper: "GIA", marketValue: 10000, kind: "fund", priced: true },
    ],
    secMeta: { MAN: { yieldPct: 3 } },
    income: 90000,
    incomeEntries: [{ date: "2026-01-01", ticker: "REAL", amount: 600, kind: "dividend" }],
    today: "2026-07-24",
  });
  const src = Object.fromEntries(plan.rows.map((r) => [r.ticker, r.yieldSource]));
  assert.equal(src.REAL, "actual");
  assert.equal(src.NONE, "assumed");
  assert.equal(src.MAN, "override");
});

test("a low-coupon gilt has tiny GIA drag — its coupon, not a 3.5% default", async () => {
  const { giaDragPct, marginalRates } = await import("../core/asset-location.mjs");
  const rates = marginalRates(200000); // additional-rate taxpayer
  const pos = { ticker: "TG31", kind: "gilt", marketValue: 50000, priced: true };
  // Without a coupon it wrongly used 3.5% → 3.5% × 45% = 1.575%.
  // With a real 0.25% coupon it should be ~0.11%, negligible.
  const withCoupon = giaDragPct(pos, { TG31: { kind: "gilt", coupon: 0.25 } }, rates);
  assert.ok(withCoupon < 0.002, `drag ${withCoupon} should be ~0.1%`);
  const noCoupon = giaDragPct(pos, {}, rates);
  assert.ok(noCoupon > 0.015, "the old default is what we're fixing");
  // capital drag stays zero either way — gilts are CGT-exempt
  assert.equal(giaDragPct({ ...pos, kind: "gilt" }, { TG31: { kind: "gilt", coupon: 0 } }, rates), 0);
});
