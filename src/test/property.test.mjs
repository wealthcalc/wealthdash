import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimatedPropertyValue, propertyEquity, netPropertyWorth, mortgageBalance,
  totalOtherLiabilities, mortgagesEndingSoon, householdNetWorth, regionLabel,
} from "../core/property.mjs";

/* --------------------------- valuation -------------------------------- */

test("estimatedPropertyValue: manual override wins outright", () => {
  const p = { valuationMode: "manual", manualValue: 500000, manualValueAsOf: "2026-06-01", purchasePrice: 300000, hpi: { purchaseIndex: 100, latestIndex: 150 } };
  const v = estimatedPropertyValue(p);
  assert.equal(v.value, 500000);
  assert.equal(v.method, "manual");
  assert.equal(v.asOf, "2026-06-01");
});

test("estimatedPropertyValue: HPI-indexed from purchase price when no manual value", () => {
  // Bought for £300k when the index was 100; index now 150 -> £450k.
  const p = { valuationMode: "hpi", purchasePrice: 300000, hpi: { purchaseMonth: "2018-06", purchaseIndex: 100, latestMonth: "2026-06", latestIndex: 150 } };
  const v = estimatedPropertyValue(p);
  assert.equal(v.value, 450000);
  assert.equal(v.method, "hpi");
  assert.equal(v.asOf, "2026-06");
  assert.equal(v.basisMonth, "2018-06");
});

test("estimatedPropertyValue: falls back to raw purchase price ('cost') before any HPI fetch", () => {
  const p = { valuationMode: "hpi", purchasePrice: 300000 };
  const v = estimatedPropertyValue(p);
  assert.equal(v.value, 300000);
  assert.equal(v.method, "cost");
  assert.equal(v.asOf, null);
});

test("estimatedPropertyValue: a zero/garbage purchaseIndex doesn't produce Infinity", () => {
  const p = { valuationMode: "hpi", purchasePrice: 300000, hpi: { purchaseIndex: 0, latestIndex: 150 } };
  const v = estimatedPropertyValue(p);
  assert.equal(v.method, "cost"); // purchaseIndex <= 0 is treated as "no usable HPI data yet"
});

/* --------------------------- equity / mortgages ------------------------ */

test("propertyEquity: value minus every mortgage linked to that property", () => {
  const property = { id: "p1", valuationMode: "manual", manualValue: 500000 };
  const mortgages = [
    { id: "m1", propertyId: "p1", balance: 200000 },
    { id: "m2", propertyId: "p1", balance: 50000 }, // e.g. a second-charge loan
    { id: "m3", propertyId: "p2", balance: 999999 }, // different property — excluded
  ];
  const eq = propertyEquity(property, mortgages);
  assert.equal(eq.value, 500000);
  assert.equal(eq.debt, 250000);
  assert.equal(eq.equity, 250000);
  assert.equal(eq.mortgageCount, 2);
});

test("netPropertyWorth: sums across properties and surfaces orphan mortgages separately", () => {
  const properties = [
    { id: "p1", valuationMode: "manual", manualValue: 500000 },
    { id: "p2", valuationMode: "manual", manualValue: 250000 },
  ];
  const mortgages = [
    { id: "m1", propertyId: "p1", balance: 200000 },
    { id: "m2", propertyId: "p2", balance: 100000 },
    { id: "m3", propertyId: "p-gone", balance: 15000 }, // property since removed
  ];
  const out = netPropertyWorth(properties, mortgages);
  assert.equal(out.value, 750000);
  assert.equal(out.debt, 315000); // 200k + 100k + 15k orphan
  assert.equal(out.equity, 435000);
  assert.equal(out.orphanMortgages.length, 1);
  assert.equal(out.rows.length, 2);
});

test("netPropertyWorth: empty inputs are all-zero, not NaN", () => {
  const out = netPropertyWorth([], []);
  assert.equal(out.value, 0);
  assert.equal(out.debt, 0);
  assert.equal(out.equity, 0);
});

/* ---------------------------- other liabilities ------------------------ */

test("totalOtherLiabilities: sums non-mortgage debts", () => {
  assert.equal(totalOtherLiabilities([{ balance: 5000 }, { balance: 12000 }]), 17000);
  assert.equal(totalOtherLiabilities([]), 0);
});

/* ------------------------------ attention ------------------------------- */

test("mortgagesEndingSoon: fixed deals within the window, sorted soonest-first, expired flagged", () => {
  const mortgages = [
    { id: "m1", rateType: "fixed", fixedEndDate: "2028-01-01" },     // > 180 days out from today -> excluded
    { id: "m2", rateType: "fixed", fixedEndDate: "2026-08-01" },     // within window
    { id: "m3", rateType: "fixed", fixedEndDate: "2026-06-01" },     // already expired
    { id: "m4", rateType: "variable", fixedEndDate: "2026-08-01" },  // not fixed -> excluded regardless of date
    { id: "m5", rateType: "fixed", fixedEndDate: null },             // no end date -> excluded
  ];
  const today = "2026-07-08";
  const soon = mortgagesEndingSoon(mortgages, today, 180);
  assert.deepEqual(soon.map((m) => m.id), ["m3", "m2"]);
  assert.equal(soon[0].expired, true);
  assert.equal(soon[1].expired, false);
});

/* -------------------------------- net worth ------------------------------ */

test("householdNetWorth: invested + property equity - other liabilities", () => {
  const out = householdNetWorth({
    investedTotal: 400000,
    properties: [{ id: "p1", valuationMode: "manual", manualValue: 500000 }],
    mortgages: [{ id: "m1", propertyId: "p1", balance: 200000 }],
    otherLiabilities: [{ balance: 15000 }], // e.g. a personal loan
  });
  assert.equal(out.propertyValue, 500000);
  assert.equal(out.propertyDebt, 200000);
  assert.equal(out.propertyEquity, 300000);
  assert.equal(out.otherLiabilities, 15000);
  assert.equal(out.totalLiabilities, 215000);
  assert.equal(out.netWorth, 400000 + 300000 - 15000);
});

test("householdNetWorth: no property/debt at all is just the invested total", () => {
  const out = householdNetWorth({ investedTotal: 123456 });
  assert.equal(out.netWorth, 123456);
  assert.equal(out.propertyEquity, 0);
  assert.equal(out.totalLiabilities, 0);
});

/* -------------------------------- regions --------------------------------- */

test("regionLabel: known slug resolves, unknown falls back to the slug itself", () => {
  assert.equal(regionLabel("london"), "London");
  assert.equal(regionLabel("nowhere"), "nowhere");
});

/* --------------------------- foreign currency ----------------------------- */

test("estimatedPropertyValue: a GBP property (implicit or explicit) is unaffected — value is the native amount, fxConverted true", () => {
  const p = { valuationMode: "manual", manualValue: 500000 };
  const v = estimatedPropertyValue(p);
  assert.equal(v.value, 500000);
  assert.equal(v.nativeValue, 500000);
  assert.equal(v.currency, "GBP");
  assert.equal(v.fxConverted, true);
  assert.equal(v.fxRate, 1);
});

test("estimatedPropertyValue: EUR property converts to GBP using the cached fxRate", () => {
  const p = { currency: "EUR", valuationMode: "manual", manualValue: 400000, fxRate: 0.85, fxAsOf: "2026-07-01" };
  const v = estimatedPropertyValue(p);
  assert.equal(v.nativeValue, 400000);
  assert.equal(v.currency, "EUR");
  assert.equal(v.value, 340000); // 400000 * 0.85
  assert.equal(v.fxConverted, true);
  assert.equal(v.fxRate, 0.85);
  assert.equal(v.fxAsOf, "2026-07-01");
});

test("estimatedPropertyValue: EUR property with no fxRate fetched yet is NOT treated as 1:1 GBP — excluded (£0), flagged fxConverted:false", () => {
  const p = { currency: "EUR", valuationMode: "manual", manualValue: 400000 };
  const v = estimatedPropertyValue(p);
  assert.equal(v.nativeValue, 400000); // native amount preserved for display
  assert.equal(v.value, 0);            // not counted in GBP totals until converted
  assert.equal(v.fxConverted, false);
  assert.equal(v.fxRate, null);
});

test("estimatedPropertyValue: HPI indexing never applies to a non-GBP property, even if valuationMode is 'hpi' — falls back to cost", () => {
  const p = { currency: "EUR", valuationMode: "hpi", purchasePrice: 300000, hpi: { purchaseIndex: 100, latestIndex: 150 } };
  const v = estimatedPropertyValue(p);
  assert.equal(v.method, "cost");
  assert.equal(v.nativeValue, 300000); // raw purchase price, not HPI-scaled
});

test("mortgageBalance: EUR mortgage converts via its own fxRate, independent of the property's currency", () => {
  const m = { currency: "EUR", balance: 200000, fxRate: 0.85 };
  const b = mortgageBalance(m);
  assert.equal(b.nativeBalance, 200000);
  assert.equal(b.balance, 170000);
  assert.equal(b.fxConverted, true);
});

test("mortgageBalance: EUR mortgage with no fxRate yet contributes £0 and is flagged, not fabricated at 1:1", () => {
  const m = { currency: "EUR", balance: 200000 };
  const b = mortgageBalance(m);
  assert.equal(b.balance, 0);
  assert.equal(b.fxConverted, false);
});

test("propertyEquity: a EUR property with a converted-EUR mortgage nets correctly in GBP", () => {
  const property = { id: "p1", currency: "EUR", valuationMode: "manual", manualValue: 400000, fxRate: 0.85 };
  const mortgages = [{ id: "m1", propertyId: "p1", currency: "EUR", balance: 200000, fxRate: 0.85 }];
  const eq = propertyEquity(property, mortgages);
  assert.equal(eq.value, 340000);  // 400000 * 0.85
  assert.equal(eq.debt, 170000);   // 200000 * 0.85
  assert.equal(eq.equity, 170000);
  assert.equal(eq.needsFxMortgages.length, 0);
});

test("propertyEquity: an unconverted mortgage is flagged in needsFxMortgages and excluded from debt (not fabricated)", () => {
  const property = { id: "p1", valuationMode: "manual", manualValue: 500000 }; // GBP property
  const mortgages = [{ id: "m1", propertyId: "p1", currency: "EUR", balance: 200000 }]; // no fxRate yet
  const eq = propertyEquity(property, mortgages);
  assert.equal(eq.debt, 0);
  assert.deepEqual(eq.needsFxMortgages, ["m1"]);
});

test("netPropertyWorth: mixed GBP + EUR portfolio sums correctly and flags unconverted records via needsFx", () => {
  const properties = [
    { id: "p1", valuationMode: "manual", manualValue: 500000 },                                  // GBP
    { id: "p2", currency: "EUR", valuationMode: "manual", manualValue: 400000, fxRate: 0.85 },    // EUR, converted
    { id: "p3", currency: "EUR", valuationMode: "manual", manualValue: 200000 },                  // EUR, NOT converted yet
  ];
  const mortgages = [
    { id: "m1", propertyId: "p1", balance: 200000 },
    { id: "m2", propertyId: "p2", currency: "EUR", balance: 100000, fxRate: 0.85 },
  ];
  const out = netPropertyWorth(properties, mortgages);
  assert.equal(out.value, 500000 + 340000 + 0); // p3 excluded until its rate is fetched
  assert.equal(out.debt, 200000 + 85000);
  assert.deepEqual(out.needsFx, ["p3"]);
});
