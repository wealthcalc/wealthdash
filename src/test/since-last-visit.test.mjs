import { test } from "node:test";
import assert from "node:assert/strict";
import { sinceLastVisit } from "../core/since-last-visit.mjs";

const TODAY = "2026-08-08";

test("reports the move since the last visit, with the income that arrived", () => {
  const r = sinceLastVisit({
    snapshots: [
      { date: "2026-07-01", value: 1000000 },
      { date: "2026-08-04", value: 1200000 },   // last visit
      { date: "2026-08-08", value: 1240000 },   // today
    ],
    incomeEntries: [
      { date: "2026-08-05", ticker: "CTY", amount: 200 },
      { date: "2026-08-07", ticker: "MYI", amount: 112 },
      { date: "2026-08-04", ticker: "OLD", amount: 999 },  // on the baseline day, not new
      { date: "2026-08-09", ticker: "FUT", amount: 500 },  // future, not yet
    ],
    today: TODAY,
  });
  assert.equal(r.available, true);
  assert.equal(r.from, "2026-08-04");
  assert.equal(r.to, "2026-08-08");
  assert.equal(r.gapDays, 4);
  assert.equal(r.change, 40000);
  assert.equal(r.direction, "up");
  assert.ok(Math.abs(r.changePct - 3.33) < 0.01);
  assert.equal(r.income.total, 312, "only income inside the window counts");
  assert.equal(r.income.count, 2);
});

test("says nothing when today's is the only snapshot, or when there's no history", () => {
  // Comparing today against itself would report £0 as if it were news.
  const sameDay = sinceLastVisit({ snapshots: [{ date: TODAY, value: 1000 }], today: TODAY });
  assert.equal(sameDay.available, false);

  assert.equal(sinceLastVisit({ snapshots: [], today: TODAY }).available, false);
  assert.equal(sinceLastVisit({ today: TODAY }).available, false);
});

test("a fall is reported as plainly as a rise", () => {
  const r = sinceLastVisit({
    snapshots: [{ date: "2026-08-01", value: 1000000 }, { date: TODAY, value: 950000 }],
    today: TODAY,
  });
  assert.equal(r.change, -50000);
  assert.equal(r.direction, "down");
  assert.equal(r.changePct, -5);
});

test("the gap is described in words that match its length", () => {
  const span = (from, to) => sinceLastVisit({
    snapshots: [{ date: from, value: 100 }, { date: to, value: 100 }], today: to,
  }).span;
  assert.equal(span("2026-08-07", "2026-08-08"), "yesterday");
  assert.equal(span("2026-08-04", "2026-08-08"), "this week");
  assert.equal(span("2026-07-20", "2026-08-08"), "this month");
  assert.equal(span("2026-05-01", "2026-08-08"), "since your last visit");
});

test("stale prices are surfaced beside the change, since they may explain it", () => {
  const r = sinceLastVisit({
    snapshots: [{ date: "2026-08-01", value: 100 }, { date: TODAY, value: 100 }],
    priceMeta: {
      FRESH: { asOf: "2026-08-08T09:00:00Z" },
      OLD: { asOf: "2026-07-01T09:00:00Z" },
      ALSOOLD: { asOf: "2026-06-01T09:00:00Z" },
    },
    today: TODAY,
  });
  assert.deepEqual(r.stalePrices, ["ALSOOLD", "OLD"]);
});

test("an estimated snapshot is flagged rather than silently dropped", () => {
  const r = sinceLastVisit({
    snapshots: [{ date: "2026-08-01", value: 100, estimated: true }, { date: TODAY, value: 120 }],
    today: TODAY,
  });
  assert.equal(r.available, true);
  assert.equal(r.estimated, true, "the UI needs to hedge this figure");
  assert.equal(r.change, 20);
});

test("requires today", () => {
  assert.throws(() => sinceLastVisit({ snapshots: [] }), /today/);
});
