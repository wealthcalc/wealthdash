import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAiSnapshot } from "../core/ai-snapshot.mjs";

const FIX = {
  today: "2026-07-16",
  netWorth: { netWorth: 500000, propertyEquity: 150000, privateValue: 20000, rsuValue: 30000, otherLiabilities: 5000, creditCardDebt: 1000 },
  model: {
    total: { total: 300000, unpriced: 1 },
    cash: { GIA: 5000 },
    positions: [
      { ticker: "VWRL", wrapper: "ISA", kind: "fund", qty: 500, priced: true, marketValue: 60000, bookCost: 40000 },
      { ticker: "WFC", wrapper: "GIA", kind: "equity", qty: 100, priced: true, marketValue: 6500, bookCost: 4000 },
      { ticker: "MYSTERY", wrapper: "GIA", kind: "equity", qty: 10, priced: false, marketValue: null, bookCost: 1000 },
      { ticker: "CITIUS", wrapper: "SIPP", kind: "fund", qty: 1000, priced: true, marketValue: 200000, bookCost: 180000 },
    ],
    allocation: { wrapper: [{ key: "ISA", marketValue: 60000, pct: 0.22 }], assetClass: [], currency: [] },
  },
  returns: {
    total: { xirr: { rate: 0.1114, xirrScope: { snapshotOnlyExcluded: 1, excludedValue: 200000 } }, trailing12m: 8000, actualYield: 0.027, forwardIncome: 8500, forwardYield: 0.028 },
    portfolioTWR: { twr: 0.05, from: "2026-01-01", to: "2026-07-16" },
  },
  pensionXirr: { SIPP: { rate: 0.081, providers: 2 } },
  concentration: { total: 266500, top1: { ticker: "CITIUS", weight: 0.75 }, top5Weight: 1, hhi: 0.6, effectiveN: 1.7, alerts: [{ ticker: "WFC", value: 6500, weight: 0.12 }] },
  regionExposure: { buckets: [{ key: "US", marketValue: 40000, pct: 0.6 }], coverage: { lookthroughPct: 0.5, taggedPct: 0.3, untaggedPct: 0.2 } },
  secMeta: { CITIUS: { provider: "Citi", name: "Citi US Fund" }, VWRL: { name: "Vanguard FTSE All-World", region: "Global" } },
  cashAccounts: [{ label: "NS&I", wrapper: "GIA", balance: 20000, rate: 4.1, rateType: "fixed", maturityDate: "2027-01-01" }],
  properties: [{}], mortgages: [{}],
};

test("snapshot carries every landmark section and headline figure", () => {
  const md = renderAiSnapshot(FIX);
  for (const s of [
    "# Portfolio snapshot — 2026-07-16",
    "Net worth: £500,000",
    "| Ticker | Name |", "| VWRL |", "Vanguard FTSE All-World",
    "## Cash", "NS&I", "matures 2027-01-01",
    "## Allocation", "## Concentration", "SINGLE-COMPANY RISK: WFC",
    "11.1%/yr", "snapshot-only pension funds excluded",
    "SIPP pension XIRR from real contribution dates: 8.1%/yr",
    "trailing 12m",
  ]) assert.ok(md.includes(s), s);
});

test("data-quality caveats appear inline where they bite", () => {
  const md = renderAiSnapshot(FIX);
  assert.ok(md.includes("1 holding(s) have no price"));
  assert.ok(md.includes("| MYSTERY |") && md.match(/MYSTERY[^\n]*n\/a/));
  assert.ok(md.includes("CITIUS") && md.includes("consolidated snapshots"));
  assert.ok(md.includes("untagged — treat region/sector rows as approximate"));
  assert.ok(md.includes("not appraisals"));
});

test("holdings sort by value, weights use the priced total, pipes are sanitised", () => {
  const md = renderAiSnapshot({
    ...FIX,
    secMeta: { ...FIX.secMeta, VWRL: { name: "Evil | pipe | name" } },
  });
  const citius = md.indexOf("| CITIUS |"), vwrl = md.indexOf("| VWRL |");
  assert.ok(citius < vwrl, "largest holding first");
  assert.ok(md.includes("Evil / pipe / name"));
  // VWRL weight = 60000 / (60000+6500+200000) = 22.5%
  assert.ok(md.includes("22.5%"));
});

test("degenerate inputs: empty model renders without NaN/undefined artefacts", () => {
  const md = renderAiSnapshot({ today: "2026-07-16" });
  assert.ok(!md.includes("NaN") && !md.includes("undefined"));
  assert.throws(() => renderAiSnapshot({}), /today/);
});
