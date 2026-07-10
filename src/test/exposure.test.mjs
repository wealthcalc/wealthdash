import { test } from "node:test";
import assert from "node:assert/strict";
import { concentration, exposureByTag, CONCENTRATION_ALERT } from "../core/exposure.mjs";

const pos = (ticker, marketValue, kind = "fund", priced = true) => ({ ticker, marketValue, kind, priced });

/* ----------------------------- concentration ---------------------------- */

test("weights, top1/top5, HHI and effective N", () => {
  const c = concentration({
    positions: [pos("VWRL", 60000), pos("WFC", 25000, "equity"), pos("TN25", 15000, "gilt")],
  });
  assert.equal(c.total, 100000);
  assert.equal(c.top1.ticker, "VWRL");
  assert.ok(Math.abs(c.top1.weight - 0.6) < 1e-9);
  assert.ok(Math.abs(c.top5Weight - 1) < 1e-9);
  const hhi = 0.36 + 0.0625 + 0.0225;
  assert.ok(Math.abs(c.hhi - hhi) < 1e-9);
  assert.ok(Math.abs(c.effectiveN - 1 / hhi) < 1e-9);
});

test("alerts fire for single equities only, never diversified funds", () => {
  const c = concentration({
    positions: [pos("VWRL", 60000), pos("WFC", 25000, "equity"), pos("TN25", 15000, "gilt")],
  });
  // VWRL is 60% but it's a fund; WFC at 25% is the only alert.
  assert.deepEqual(c.alerts.map((a) => a.ticker), ["WFC"]);
  assert.ok(c.alerts[0].weight >= CONCENTRATION_ALERT);
});

test("RSU extras merge with a ledger position in the same ticker", () => {
  const c = concentration({
    positions: [pos("VWRL", 60000), pos("WFC", 10000, "equity")],
    extras: [{ ticker: "WFC", value: 30000, label: "RSU held shares" }],
  });
  const wfc = c.rows.find((r) => r.ticker === "WFC");
  assert.equal(wfc.value, 40000);
  assert.ok(Math.abs(wfc.weight - 0.4) < 1e-9);
  assert.deepEqual(c.alerts.map((a) => a.ticker), ["WFC"]);
  // and the merge treats the combined line as equity risk even though the
  // extra arrived without an explicit kind
  assert.equal(wfc.kind, "equity");
});

test("unpriced positions and empty inputs are handled", () => {
  const c = concentration({ positions: [pos("X", 100, "equity", false)] });
  assert.equal(c.total, 0);
  assert.equal(c.top1, null);
  assert.deepEqual(c.alerts, []);
});

/* ----------------------------- exposureByTag ---------------------------- */

const SECMETA = {
  VWRL: { region: "Global", sector: "Diversified" },
  WFC: { region: "US", sector: "Financials" },
  TN25: {}, // untagged
};

test("rolls up by tag with untagged kept visible", () => {
  const e = exposureByTag({
    positions: [pos("VWRL", 60000), pos("WFC", 25000, "equity"), pos("TN25", 15000, "gilt")],
    secMeta: SECMETA, field: "region",
  });
  assert.deepEqual(e.buckets.map((b) => [b.key, b.marketValue]), [
    ["Global", 60000], ["US", 25000], ["untagged", 15000],
  ]);
  assert.equal(e.untaggedValue, 15000);
  assert.equal(e.untaggedCount, 1);
  assert.ok(Math.abs(e.untaggedPct - 0.15) < 1e-9);
});

test("same ticker across wrappers counts once in untaggedCount but sums value", () => {
  const e = exposureByTag({
    positions: [pos("TN25", 10000, "gilt"), pos("TN25", 5000, "gilt")],
    secMeta: {}, field: "region",
  });
  assert.equal(e.untaggedValue, 15000);
  assert.equal(e.untaggedCount, 1);
});

test("whitespace-only tags count as untagged; unpriced excluded", () => {
  const e = exposureByTag({
    positions: [pos("A", 100, "equity"), pos("B", 50, "equity", false)],
    secMeta: { A: { region: "  " } }, field: "region",
  });
  assert.equal(e.total, 100);
  assert.equal(e.buckets[0].key, "untagged");
});
