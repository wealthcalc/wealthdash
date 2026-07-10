import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildNetWorthSnapshot, upsertDailySnapshot, snapshotAtOrBefore, overlaySeries,
} from "../core/net-worth-series.mjs";

const TOTAL = { marketValue: 100000.005, cash: 5000, total: 105000, unpriced: 0 };
const NW = {
  netWorth: 250000.004, propertyEquity: 150000, privateValue: 10000, rsuValue: 5000,
  otherLiabilities: 12000, creditCardDebt: 3000,
};

/* ------------------------ buildNetWorthSnapshot ------------------------ */

test("builds a rounded record with liabilities combined", () => {
  const r = buildNetWorthSnapshot({ date: "2026-07-10", total: TOTAL, netWorth: NW });
  assert.equal(r.date, "2026-07-10");
  assert.equal(r.value, 250000);
  assert.equal(r.invested, 100000.01);
  assert.equal(r.cash, 5000);
  assert.equal(r.propertyEquity, 150000);
  assert.equal(r.liabilities, 15000); // otherLiabilities + creditCardDebt
  assert.equal(r.estimated, false);
  assert.equal(r.unpriced, 0);
});

test("unpriced holdings mark the record estimated, not skipped", () => {
  const r = buildNetWorthSnapshot({ date: "2026-07-10", total: { ...TOTAL, unpriced: 2 }, netWorth: NW });
  assert.equal(r.estimated, true);
  assert.equal(r.unpriced, 2);
});

test("all-zero first-run state records nothing", () => {
  const zeroTotal = { marketValue: 0, cash: 0, total: 0, unpriced: 0 };
  const zeroNW = { netWorth: 0, propertyEquity: 0, privateValue: 0, rsuValue: 0, otherLiabilities: 0, creditCardDebt: 0 };
  assert.equal(buildNetWorthSnapshot({ date: "2026-07-10", total: zeroTotal, netWorth: zeroNW }), null);
});

test("a negative net worth (real: liabilities exceed assets) still records", () => {
  const nw = { ...NW, netWorth: -5000 };
  const r = buildNetWorthSnapshot({ date: "2026-07-10", total: TOTAL, netWorth: nw });
  assert.equal(r.value, -5000);
});

test("missing inputs return null rather than a fabricated row", () => {
  assert.equal(buildNetWorthSnapshot({ date: "2026-07-10", total: null, netWorth: NW }), null);
  assert.equal(buildNetWorthSnapshot({ date: "", total: TOTAL, netWorth: NW }), null);
});

/* ------------------------- upsertDailySnapshot ------------------------- */

const rec = (date, value, extra = {}) => ({
  date, value, invested: value, cash: 0, propertyEquity: 0, privateValue: 0,
  rsuValue: 0, liabilities: 0, estimated: false, unpriced: 0, ...extra,
});

test("inserts sorted and last-write-wins per day", () => {
  let s = [];
  s = upsertDailySnapshot(s, rec("2026-07-02", 100));
  s = upsertDailySnapshot(s, rec("2026-07-01", 90));
  s = upsertDailySnapshot(s, rec("2026-07-02", 110)); // same-day revision
  assert.deepEqual(s.map((x) => [x.date, x.value]), [["2026-07-01", 90], ["2026-07-02", 110]]);
});

test("identical same-day record returns the SAME array reference (no churn)", () => {
  const s = [rec("2026-07-01", 90)];
  assert.equal(upsertDailySnapshot(s, rec("2026-07-01", 90)), s);
  assert.notEqual(upsertDailySnapshot(s, rec("2026-07-01", 91)), s);
  // estimated flag flipping IS a change worth writing
  assert.notEqual(upsertDailySnapshot(s, rec("2026-07-01", 90, { estimated: true, unpriced: 1 })), s);
});

test("null record is a no-op", () => {
  const s = [rec("2026-07-01", 90)];
  assert.equal(upsertDailySnapshot(s, null), s);
});

/* -------------------------- snapshotAtOrBefore ------------------------- */

test("finds the latest record on/before a date", () => {
  const s = [rec("2026-06-01", 1), rec("2026-06-15", 2), rec("2026-07-01", 3)];
  assert.equal(snapshotAtOrBefore(s, "2026-06-20").value, 2);
  assert.equal(snapshotAtOrBefore(s, "2026-06-15").value, 2);
  assert.equal(snapshotAtOrBefore(s, "2026-05-31"), null);
});

/* ----------------------------- overlaySeries --------------------------- */

const bench = [
  { date: "2026-06-30", close: 95 },  // before the series — excluded
  { date: "2026-07-01", close: 100 },
  { date: "2026-07-05", close: 110 },
  { date: "2026-07-10", close: 90 },
  { date: "2026-07-11", close: 130 }, // after the series — excluded
];
const values = [rec("2026-07-01", 200000), rec("2026-07-10", 210000)];

test("rebases the benchmark to the series' first value over the overlap", () => {
  const o = overlaySeries(bench, values);
  assert.deepEqual(o.map((p) => [p.date, p.value]), [
    ["2026-07-01", 200000],
    ["2026-07-05", 220000], // +10%
    ["2026-07-10", 180000], // -10%
  ]);
});

test("no overlap, too-short series, or zero start value -> empty overlay", () => {
  assert.deepEqual(overlaySeries(bench, [values[0]]), []); // < 2 points
  assert.deepEqual(overlaySeries([], values), []);
  assert.deepEqual(overlaySeries([{ date: "2027-01-01", close: 100 }], values), []);
  assert.deepEqual(overlaySeries(bench, [rec("2026-07-01", 0), rec("2026-07-10", 5)]), []);
});

test("non-finite or zero closes are dropped, not divided by", () => {
  const dirty = [{ date: "2026-07-01", close: 0 }, { date: "2026-07-02", close: NaN }, { date: "2026-07-03", close: 100 }, { date: "2026-07-09", close: 150 }];
  const o = overlaySeries(dirty, values);
  assert.deepEqual(o.map((p) => [p.date, p.value]), [["2026-07-03", 200000], ["2026-07-09", 300000]]);
});
