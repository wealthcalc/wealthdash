import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunoff } from "../core/runoff-model.mjs";

const BASE = { annualExpense: 40000, inflation: 0, startYear: 2027, years: 5 };

test("strict source order within a year: gilts, cash, deferred, RSU, dividends, then portfolio", () => {
  const { rows } = buildRunoff({
    ...BASE, years: 1,
    giltNominalByYear: { 2027: 10000 }, cashStart: 8000,
    deferredByYear: { 2027: 6000 }, rsuByYear: { 2027: 5000 }, annualDividends: 4000,
  });
  const r = rows[0];
  assert.deepEqual(
    [r.fromGilts, r.fromCash, r.fromDeferred, r.fromRsu, r.fromDividends, r.fromPortfolio],
    [10000, 8000, 6000, 5000, 4000, 7000]
  );
  assert.equal(r.covered, false);
});

test("THE new mechanic: a gilt maturity surplus banks and funds LATER years before cash", () => {
  const { rows } = buildRunoff({
    ...BASE, years: 3,
    giltNominalByYear: { 2027: 100000 }, // one big maturity, then nothing
    cashStart: 50000,
  });
  // year 1: expense 40k from gilts, 60k banks
  assert.equal(rows[0].fromGilts, 40000);
  assert.equal(rows[0].giltBankEnd, 60000);
  assert.equal(rows[0].fromCash, 0);
  // year 2: funded ENTIRELY from the bank — cash untouched
  assert.equal(rows[1].fromGilts, 40000);
  assert.equal(rows[1].giltBankEnd, 20000);
  assert.equal(rows[1].fromCash, 0);
  // year 3: bank's last 20k, then cash starts
  assert.equal(rows[2].fromGilts, 20000);
  assert.equal(rows[2].giltBankEnd, 0);
  assert.equal(rows[2].fromCash, 20000);
  assert.equal(rows[2].cashEnd, 30000);
});

test("surplus deferred/RSU income beyond the year's need becomes cash, not lost", () => {
  const { rows } = buildRunoff({
    ...BASE, years: 2,
    deferredByYear: { 2027: 100000 }, // huge tranche in year 1
  });
  assert.equal(rows[0].fromDeferred, 40000);
  assert.equal(rows[0].cashEnd, 60000);   // surplus banked as cash
  assert.equal(rows[0].surplusToCash, 60000); // and the top-up is surfaced per-row
  assert.equal(rows[1].fromCash, 40000);  // and funds year 2
  assert.equal(rows[1].fromPortfolio, 0);
  assert.equal(rows[1].surplusToCash, 0);
});

test("the rising-cash case the UI must explain: gilts cover the spend, dividends pile into cash", () => {
  // This is the real-portfolio shape behind the question "why is cash
  // going UP?" — the ladder alone covers early years, so the whole
  // dividend stream is surplus and banks into the float untouched.
  const { rows } = buildRunoff({
    ...BASE, years: 2,
    giltNominalByYear: { 2027: 40000, 2028: 40000 },
    cashStart: 120000, annualDividends: 15000,
  });
  assert.equal(rows[0].fromCash, 0);
  assert.equal(rows[0].fromDividends, 0);      // nothing needed from them
  assert.equal(rows[0].surplusToCash, 15000);  // so they all bank
  assert.equal(rows[0].cashEnd, 135000);
  assert.equal(rows[1].cashEnd, 150000);
});

test("THE reporting fix: a source shows what ARRIVED even when the waterfall didn't need it", () => {
  // The complaint this encodes: dividends/vests/deferred read £0 in the
  // waterfall columns whenever gilts already covered the spend, which
  // looks like "I receive nothing that year" rather than "that money went
  // to the float". totalIn/net must tell the true story.
  const { rows } = buildRunoff({
    ...BASE, years: 1,
    giltNominalByYear: { 2027: 40000 },   // covers the whole 40k spend
    deferredByYear: { 2027: 25000 }, rsuByYear: { 2027: 15000 }, annualDividends: 12000,
  });
  const r = rows[0];
  // waterfall view: everything after gilts reads zero — money USED
  assert.deepEqual([r.fromDeferred, r.fromRsu, r.fromDividends], [0, 0, 0]);
  // cash-flow view: the money is all visibly there — money RECEIVED
  assert.deepEqual([r.deferredIn, r.rsuIn, r.divIn], [25000, 15000, 12000]);
  assert.equal(r.totalIn, 92000);
  assert.equal(r.net, 52000);           // 92k in, 40k spent
  assert.equal(r.surplusToCash, 52000); // and it lands in the float
  assert.equal(r.covered, true);
});

test("net exposes a year that draws down the float while looking 'covered'", () => {
  const { rows } = buildRunoff({
    ...BASE, years: 1, cashStart: 100000, annualDividends: 5000,
  });
  const r = rows[0];
  assert.equal(r.covered, true);   // no portfolio sale needed…
  assert.equal(r.net, -35000);     // …but 35k of float was consumed
  assert.equal(r.balanceEnd, 65000);
});

test("gross inflows + balance for the cash-flow view: received ≠ used", () => {
  const { rows } = buildRunoff({
    ...BASE, years: 2,
    giltNominalByYear: { 2027: 100000 },  // covers year 1, banks 60k
    cashStart: 20000, annualDividends: 15000,
    deferredByYear: { 2027: 5000 }, rsuByYear: { 2028: 8000 },
  });
  const r0 = rows[0];
  // gross inflows are what ARRIVED, regardless of the waterfall's need
  assert.deepEqual([r0.giltIn, r0.deferredIn, r0.rsuIn, r0.divIn], [100000, 5000, 0, 15000]);
  assert.equal(r0.fromDividends, 0); // used none of them…
  assert.equal(r0.divIn, 15000);     // …but received all of them
  // balance = cash + gilt bank: 20000 + (5000+15000 surplus) + 60000 bank
  assert.equal(r0.cashEnd, 40000);
  assert.equal(r0.giltBankEnd, 60000);
  assert.equal(r0.balanceEnd, 100000);
  // year 2: expense 40k from bank(40k of 60k); rsu 8k + div 15k surplus → cash
  assert.equal(rows[1].giltIn, 0);
  assert.equal(rows[1].rsuIn, 8000);
  assert.equal(rows[1].balanceEnd, 40000 + 8000 + 15000 + 20000);
});

test("expense uprates with inflation; dividends stay flat (the disclosed assumption)", () => {
  const { rows } = buildRunoff({ ...BASE, inflation: 3, years: 2, annualDividends: 10000 });
  assert.equal(rows[0].expense, 40000);
  assert.equal(rows[1].expense, 41200);
  assert.equal(rows[0].fromDividends, 10000);
  assert.equal(rows[1].fromDividends, 10000);
  assert.equal(rows[1].fromPortfolio, 31200);
});

test("cliff vs permanent cliff: a late maturity can rescue a year after the first breach", () => {
  const { rows, summary } = buildRunoff({
    ...BASE, years: 4,
    giltNominalByYear: { 2027: 40000, 2029: 40000 }, // gap year 2028, rescue 2029
  });
  assert.deepEqual(rows.map((r) => r.covered), [true, false, true, false]);
  assert.equal(summary.firstDisposalYear, 2028);
  assert.equal(summary.permanentDisposalFrom, 2030);
  assert.equal(summary.coveredYears, 2);
  assert.equal(summary.giltLadderEndsYear, 2029);
});

test("summary totals and degenerate inputs", () => {
  const r = buildRunoff({ ...BASE, years: 2, cashStart: 40000 });
  assert.equal(r.summary.totalFromPortfolio, 40000); // year 2 entirely portfolio
  assert.equal(r.summary.cashExhaustedYear, 2027);
  assert.equal(buildRunoff({ annualExpense: 0, startYear: 2027 }).summary, null);
  assert.throws(() => buildRunoff({ annualExpense: 1 }), /startYear/);
});
