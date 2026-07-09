import { test } from "node:test";
import assert from "node:assert/strict";
import {
  holdingEvents, holdingSummary, cgtExemptionStatus, reliefByYear, lossReliefEligible, privateTotals,
  RELIEF_RATE, EIS_ANNUAL_CAP, SEIS_ANNUAL_CAP,
} from "../core/private-investments.mjs";

const h = (over) => ({ id: "h1", name: "Test Co", type: "EIS", shareIssueDate: "2023-06-01", currentValuation: 0, ...over });

/* -------------------------------- events ---------------------------------- */

test("holdingEvents: filters to just the given holding", () => {
  const events = [
    { holdingId: "h1", type: "call", date: "2023-06-01", amount: 10000 },
    { holdingId: "h2", type: "call", date: "2023-06-01", amount: 5000 },
  ];
  assert.equal(holdingEvents("h1", events).length, 1);
});

/* ----------------------------- holdingSummary ------------------------------ */

test("holdingSummary: staged LP-style capital calls sum correctly", () => {
  const holding = h({ id: "lp1", type: "LP", currentValuation: 30000 });
  const events = [
    { holdingId: "lp1", type: "call", date: "2022-01-01", amount: 20000 },
    { holdingId: "lp1", type: "call", date: "2023-01-01", amount: 10000 },
  ];
  const s = holdingSummary(holding, events, "2026-01-01");
  assert.equal(s.called, 30000);
  assert.equal(s.currentValue, 30000);
  assert.equal(s.moic, 1); // 30000 back (unrealised) / 30000 called
});

test("holdingSummary: distributions + current value compose MOIC", () => {
  const holding = h({ id: "h1", type: "LP", currentValuation: 15000 });
  const events = [
    { holdingId: "h1", type: "call", date: "2020-01-01", amount: 10000 },
    { holdingId: "h1", type: "distribution_capital", date: "2024-01-01", amount: 5000 },
  ];
  const s = holdingSummary(holding, events, "2026-01-01");
  assert.equal(s.distCapital, 5000);
  assert.equal(s.moic, 2); // (5000 + 15000) / 10000
});

test("holdingSummary: written off holding has currentValue forced to 0 regardless of manual valuation", () => {
  const holding = h({ id: "h1", currentValuation: 8000 });
  const events = [
    { holdingId: "h1", type: "call", date: "2022-01-01", amount: 10000 },
    { holdingId: "h1", type: "write_off", date: "2025-01-01" },
  ];
  const s = holdingSummary(holding, events, "2026-01-01");
  assert.equal(s.currentValue, 0);
  assert.equal(s.writtenOff, true);
  assert.equal(s.moic, 0); // nothing back, nothing left
});

test("holdingSummary: no calls yet -> moic is null, not divide-by-zero garbage", () => {
  const holding = h({ id: "h1", currentValuation: 0 });
  const s = holdingSummary(holding, [], "2026-01-01");
  assert.equal(s.called, 0);
  assert.equal(s.moic, null);
});

test("holdingSummary: XIRR uses calls as negative flows, distributions positive, valuation as terminal", () => {
  const holding = h({ id: "h1", type: "LP", currentValuation: 12000, valuationAsOf: "2026-01-01" });
  const events = [{ holdingId: "h1", type: "call", date: "2025-01-01", amount: 10000 }];
  const s = holdingSummary(holding, events, "2026-01-01");
  // one year, 10000 -> 12000 = 20% return
  assert.ok(s.irr.rate > 0.15 && s.irr.rate < 0.25);
});

/* --------------------------- CGT exemption clock ---------------------------- */

test("cgtExemptionStatus: LP/other holdings never get the EIS/SEIS 3-year exemption", () => {
  assert.equal(cgtExemptionStatus(h({ type: "LP" }), "2030-01-01").applies, false);
  assert.equal(cgtExemptionStatus(h({ type: "other" }), "2030-01-01").applies, false);
});

test("cgtExemptionStatus: exempt once 3 years have passed since share issue", () => {
  const holding = h({ type: "EIS", shareIssueDate: "2023-06-01" });
  assert.equal(cgtExemptionStatus(holding, "2025-06-01").exempt, false); // exactly 2 years
  assert.equal(cgtExemptionStatus(holding, "2026-06-01").exempt, true);  // exactly 3 years
  assert.equal(cgtExemptionStatus(holding, "2026-05-31").exempt, false); // 1 day short
});

test("cgtExemptionStatus: missing share issue date is flagged, not silently exempt", () => {
  const holding = h({ type: "SEIS", shareIssueDate: null });
  const status = cgtExemptionStatus(holding, "2030-01-01");
  assert.equal(status.applies, true);
  assert.equal(status.exempt, false);
  assert.ok(status.reason);
});

/* ------------------------------- reliefByYear ------------------------------- */

test("reliefByYear: EIS 30% / SEIS 50% computed from each holding's first call, grouped by tax year", () => {
  const holdings = [
    h({ id: "e1", type: "EIS" }),
    h({ id: "s1", type: "SEIS" }),
  ];
  const events = [
    { holdingId: "e1", type: "call", date: "2023-06-01", amount: 10000 },
    { holdingId: "s1", type: "call", date: "2023-08-01", amount: 20000 },
  ];
  const byYear = reliefByYear(holdings, events);
  assert.equal(byYear["2023/24"].EIS.invested, 10000);
  assert.equal(byYear["2023/24"].EIS.relief, 3000); // 30%
  assert.equal(byYear["2023/24"].SEIS.invested, 20000);
  assert.equal(byYear["2023/24"].SEIS.relief, 10000); // 50%
});

test("reliefByYear: aggregates ACROSS multiple EIS holdings in the same tax year (combined, not per-holding)", () => {
  const holdings = [h({ id: "e1", type: "EIS" }), h({ id: "e2", type: "EIS" })];
  const events = [
    { holdingId: "e1", type: "call", date: "2023-05-01", amount: 600000 },
    { holdingId: "e2", type: "call", date: "2023-09-01", amount: 500000 },
  ];
  const byYear = reliefByYear(holdings, events);
  assert.equal(byYear["2023/24"].EIS.invested, 1100000);
  assert.equal(byYear["2023/24"].EIS.overCap, true); // > EIS_ANNUAL_CAP (1,000,000)
});

test("reliefByYear: SEIS respects its own, lower annual cap", () => {
  const holdings = [h({ id: "s1", type: "SEIS" })];
  const events = [{ holdingId: "s1", type: "call", date: "2023-06-01", amount: 250000 }];
  const byYear = reliefByYear(holdings, events);
  assert.equal(byYear["2023/24"].SEIS.overCap, true); // > SEIS_ANNUAL_CAP (200,000)
});

test("reliefByYear: LP/other holdings never contribute relief", () => {
  const holdings = [h({ id: "lp1", type: "LP" })];
  const events = [{ holdingId: "lp1", type: "call", date: "2023-06-01", amount: 50000 }];
  const byYear = reliefByYear(holdings, events);
  assert.deepEqual(byYear, {});
});

test("reliefByYear: a custom reliefPct override on the holding wins over the type default", () => {
  const holdings = [h({ id: "e1", type: "EIS", reliefPct: 20 })]; // relief later reduced/partially claimed
  const events = [{ holdingId: "e1", type: "call", date: "2023-06-01", amount: 10000 }];
  const byYear = reliefByYear(holdings, events);
  assert.equal(byYear["2023/24"].EIS.relief, 2000); // 20%, not the default 30%
});

/* --------------------------- lossReliefEligible ----------------------------- */

test("lossReliefEligible: null for LP/other — ordinary CGT loss rules apply instead", () => {
  assert.equal(lossReliefEligible(h({ type: "LP" }), []), null);
  assert.equal(lossReliefEligible(h({ type: "other" }), []), null);
});

test("lossReliefEligible: written-off EIS holding — loss is invested minus income tax relief already given", () => {
  const holding = h({ id: "h1", type: "EIS" }); // 30% relief
  const events = [
    { holdingId: "h1", type: "call", date: "2022-01-01", amount: 10000 },
    { holdingId: "h1", type: "write_off", date: "2025-01-01" },
  ];
  const lr = lossReliefEligible(holding, events);
  assert.equal(lr.incomeTaxReliefGiven, 3000);
  assert.equal(lr.netCost, 7000);
  assert.equal(lr.eligible, true);
  assert.equal(lr.amount, 7000); // nothing at all came back
});

test("lossReliefEligible: partial capital returned before write-off reduces the eligible loss", () => {
  const holding = h({ id: "h1", type: "SEIS" }); // 50% relief
  const events = [
    { holdingId: "h1", type: "call", date: "2022-01-01", amount: 10000 },
    { holdingId: "h1", type: "distribution_capital", date: "2024-01-01", amount: 2000 },
    { holdingId: "h1", type: "write_off", date: "2025-01-01" },
  ];
  const lr = lossReliefEligible(holding, events);
  // net cost 10000 - 5000 relief = 5000; already got 2000 back -> loss 3000
  assert.equal(lr.netCost, 5000);
  assert.equal(lr.amount, 3000);
});

test("lossReliefEligible: a holding still worth more than its net cost is not eligible", () => {
  const holding = h({ id: "h1", type: "EIS", currentValuation: 9000 });
  const events = [{ holdingId: "h1", type: "call", date: "2022-01-01", amount: 10000 }];
  const lr = lossReliefEligible(holding, events);
  // net cost 7000 (after 30% relief), still worth 9000 -> no loss
  assert.equal(lr.eligible, false);
  assert.equal(lr.amount, 0);
});

/* ------------------------------- privateTotals ------------------------------- */

test("privateTotals: sums across every holding", () => {
  const holdings = [
    h({ id: "h1", type: "LP", currentValuation: 15000 }),
    h({ id: "h2", type: "EIS", currentValuation: 5000 }),
  ];
  const events = [
    { holdingId: "h1", type: "call", date: "2020-01-01", amount: 10000 },
    { holdingId: "h2", type: "call", date: "2021-01-01", amount: 5000 },
    { holdingId: "h2", type: "distribution_income", date: "2023-01-01", amount: 500 },
  ];
  const t = privateTotals(holdings, events, "2026-01-01");
  assert.equal(t.called, 15000);
  assert.equal(t.currentValue, 20000);
  assert.equal(t.distIncome, 500);
  assert.equal(t.rows.length, 2);
});

test("privateTotals: empty portfolio is all-zero, not NaN", () => {
  const t = privateTotals([], [], "2026-01-01");
  assert.equal(t.called, 0);
  assert.equal(t.currentValue, 0);
  assert.deepEqual(t.rows, []);
  assert.equal(t.moic, null);
});

test("privateTotals: blended MOIC and XIRR pool every holding's cashflows together", () => {
  const holdings = [
    h({ id: "h1", type: "LP", currentValuation: 20000 }),
    h({ id: "h2", type: "EIS", currentValuation: 0 }),
  ];
  const events = [
    { holdingId: "h1", type: "call", date: "2024-01-01", amount: 10000 },
    { holdingId: "h2", type: "call", date: "2024-01-01", amount: 10000 },
    { holdingId: "h2", type: "distribution_capital", date: "2025-01-01", amount: 12000 },
  ];
  const t = privateTotals(holdings, events, "2026-01-01");
  // total called 20000; total back (12000 distributed + 20000 unrealised) = 32000
  assert.equal(t.moic, 1.6);
  assert.ok(t.irr.rate > 0); // net positive across the pooled cashflows
});

/* --------------------------------- constants --------------------------------- */

test("relief rate and cap constants match the modelled 2025/26 figures", () => {
  assert.equal(RELIEF_RATE.EIS, 30);
  assert.equal(RELIEF_RATE.SEIS, 50);
  assert.equal(RELIEF_RATE.LP, 0);
  assert.equal(EIS_ANNUAL_CAP, 1000000);
  assert.equal(SEIS_ANNUAL_CAP, 200000);
});
