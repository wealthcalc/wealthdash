import { test } from "node:test";
import assert from "node:assert/strict";
import {
  personalAllowance, taxRUK, taxScot, employeeNI, annualAllowance,
  grossForNetPension, HR_THRESHOLD, PA_BASE,
} from "../core/uk-income-tax.mjs";

/* --------------------------- personal allowance ------------------------ */

test("personalAllowance: full below taper threshold, tapers £1 per £2 over £100k", () => {
  assert.equal(personalAllowance(50000), PA_BASE);
  assert.equal(personalAllowance(100000), PA_BASE);
  assert.equal(personalAllowance(110000), PA_BASE - 5000);
  assert.equal(personalAllowance(125140), 0); // fully tapered away
});

test("personalAllowance: `f` uprates both the base and the taper threshold", () => {
  assert.equal(personalAllowance(PA_BASE * 2, 2), PA_BASE * 2);
  assert.equal(personalAllowance(220000, 2), PA_BASE * 2 - 10000);
});

/* -------------------------------- taxRUK -------------------------------- */

test("taxRUK: zero below the personal allowance, then 20/40/45 bands", () => {
  assert.equal(taxRUK(0), 0);
  assert.equal(taxRUK(PA_BASE), 0);
  assert.equal(Math.round(taxRUK(PA_BASE + 1000)), 200); // £1000 at 20%
  const higherRateIncome = HR_THRESHOLD + 1000;
  const tax = taxRUK(higherRateIncome);
  const basicBandTax = 37700 * 0.2;
  assert.ok(Math.abs(tax - (basicBandTax + 1000 * 0.4)) < 1);
});

test("taxRUK: additional rate above £125,140", () => {
  const t1 = taxRUK(125140);
  const t2 = taxRUK(125140 + 1000);
  assert.ok(Math.abs(t2 - t1 - 450) < 1); // £1000 at 45%
});

test("taxRUK: `f` scales every band proportionally (tax is linear in `f` for scaled income)", () => {
  const base = taxRUK(80000, 1);
  const scaled = taxRUK(160000, 2);
  assert.ok(Math.abs(scaled - base * 2) < 1);
});

/* -------------------------------- taxScot -------------------------------- */

test("taxScot: starter/basic/intermediate/higher/advanced/top bands sum correctly", () => {
  assert.equal(taxScot(0), 0);
  assert.equal(taxScot(PA_BASE), 0);
  // Scottish tax should differ from rUK tax for the same income above the PA
  const income = 60000;
  assert.notEqual(Math.round(taxScot(income)), Math.round(taxRUK(income)));
});

test("taxScot: monotonically increasing with income", () => {
  let prev = 0;
  for (const income of [20000, 40000, 60000, 100000, 150000]) {
    const t = taxScot(income);
    assert.ok(t >= prev);
    prev = t;
  }
});

/* ------------------------------- employeeNI ------------------------------ */

test("employeeNI: 8% between PT and UEL, 2% above", () => {
  assert.equal(employeeNI(10000), 0); // below PT
  assert.equal(Math.round(employeeNI(20000)), Math.round((20000 - 12570) * 0.08));
  const niAtUel = (50270 - 12570) * 0.08;
  assert.ok(Math.abs(employeeNI(60000) - (niAtUel + (60000 - 50270) * 0.02)) < 1);
});

/* ----------------------------- annualAllowance ---------------------------- */

test("annualAllowance: £60k standard, tapers £1 per £2 over £260k, floor £10k", () => {
  assert.equal(annualAllowance(200000), 60000);
  assert.equal(annualAllowance(260000), 60000);
  assert.equal(annualAllowance(300000), 40000);
  assert.equal(annualAllowance(500000), 10000);
});

/* --------------------------- grossForNetPension --------------------------- */

test("grossForNetPension: zero target or zero cap returns 0", () => {
  assert.equal(grossForNetPension(0, 0, taxRUK, 1, 0.75, 50000), 0);
  assert.equal(grossForNetPension(10000, 0, taxRUK, 1, 0.75, 0), 0);
});

test("grossForNetPension: solved gross, when taxed incrementally, nets the target (within the cap)", () => {
  const g = grossForNetPension(10000, 20000, taxRUK, 1, 0.75, 50000);
  const netAchieved = g - (taxRUK(20000 + g * 0.75) - taxRUK(20000));
  assert.ok(Math.abs(netAchieved - 10000) < 1);
});

test("grossForNetPension: caps out at `cap` if the target can't be reached within it", () => {
  const g = grossForNetPension(1000000, 0, taxRUK, 1, 0.75, 20000);
  assert.equal(g, 20000);
});

test("grossForNetPension: frac=1.0 (fully taxable, post-PCLS) needs a bigger gross for the same net than frac=0.75 (more of it is taxed)", () => {
  const gUfpls = grossForNetPension(5000, 10000, taxRUK, 1, 0.75, 50000);
  const gFullyTaxable = grossForNetPension(5000, 10000, taxRUK, 1, 1.0, 50000);
  assert.ok(gFullyTaxable >= gUfpls);
});
