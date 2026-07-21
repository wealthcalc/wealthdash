import { test } from "node:test";
import assert from "node:assert/strict";
import { trackPlan, projectedAt } from "../core/plan-tracking.mjs";

// One row per year, pot growing 100k -> 130k over three years.
const TIMELINE = [
  { age: 50, potNominal: 100000, phase: "accum" },
  { age: 51, potNominal: 110000, phase: "accum" },
  { age: 52, potNominal: 120000, phase: "accum" },
  { age: 53, potNominal: 130000, phase: "accum" },
];
const ANCHOR = { anchorDate: "2026-01-01", currentAge: 50 };

test("projectedAt interpolates between annual rows instead of stepping", () => {
  assert.equal(projectedAt(TIMELINE, 50), 100000);
  assert.equal(projectedAt(TIMELINE, 50.5), 105000);  // half-way, not 100k
  assert.equal(projectedAt(TIMELINE, 52.25), 122500);
  // clamped outside the range rather than extrapolated
  assert.equal(projectedAt(TIMELINE, 40), 100000);
  assert.equal(projectedAt(TIMELINE, 99), 130000);
  assert.equal(projectedAt([], 50), null);
});

test("tracks actual against plan and reports the gap both ways", () => {
  const { rows, summary } = trackPlan({
    ...ANCHOR, timeline: TIMELINE,
    snapshots: [
      { date: "2026-01-01", investable: 100000 }, // exactly on plan
      { date: "2027-01-01", investable: 104500 }, // 110k projected -> 5% behind
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].variance, 0);
  assert.ok(Math.abs(rows[1].projected - 110000) < 200, `${rows[1].projected}`);
  assert.ok(rows[1].variance < 0);
  assert.ok(Math.abs(rows[1].variancePct + 5) < 0.3, `${rows[1].variancePct}`);
  assert.equal(summary.ahead, false);
  assert.equal(summary.onTrack, true);   // 5% is inside the band
  assert.equal(summary.points, 2);
});

test("the on-track BAND: a projection isn't accurate to the pound", () => {
  const behind = (v) => trackPlan({
    ...ANCHOR, timeline: TIMELINE,
    snapshots: [{ date: "2026-01-01", investable: 100000 }, { date: "2027-01-01", investable: v }],
  }).summary.onTrack;
  assert.equal(behind(107000), true);   // ~2.7% behind — noise
  assert.equal(behind(101000), true);   // ~8.2% — uncomfortable but inside
  assert.equal(behind(95000), false);   // ~13.6% behind — real
  assert.equal(behind(130000), false);  // far ahead is also "not on track"
});

test("trend uses PERCENTAGE gap — an absolute gap grows with the pot even when tracking perfectly", () => {
  // Actual runs a constant 10% below plan at both ends: absolute gap
  // widens (10k -> 13k) but the percentage is unchanged, so trend ~0.
  const { summary } = trackPlan({
    ...ANCHOR, timeline: TIMELINE,
    snapshots: [
      { date: "2026-01-01", investable: 90000 },
      { date: "2029-01-01", investable: 117000 },
    ],
  });
  assert.ok(Math.abs(summary.trendPct) < 0.5, `trend ${summary.trendPct}`);
  assert.ok(summary.latest.variance < -10000, "absolute gap did widen");
});

test("refuses to summarise a single point, and explains why", () => {
  const r = trackPlan({
    ...ANCHOR, timeline: TIMELINE,
    snapshots: [{ date: "2026-06-01", investable: 100000 }],
  });
  assert.equal(r.summary, null);
  assert.match(r.reason, /snapshot/);
  assert.equal(r.rows.length, 1);
});

test("junk snapshots are skipped, not allowed to poison the series", () => {
  const { rows } = trackPlan({
    ...ANCHOR, timeline: TIMELINE,
    snapshots: [
      { date: "2026-01-01", investable: 100000 },
      { date: "not-a-date", investable: 5 },
      { date: "2026-06-01" },                 // no value
      { date: "2026-07-01", investable: null },
      { date: "2027-01-01", investable: 110000 },
    ],
  });
  assert.equal(rows.length, 2);
});

test("the age/date anchor is required — the two series aren't otherwise comparable", () => {
  assert.throws(() => trackPlan({ timeline: TIMELINE, snapshots: [] }), /anchorDate/);
  assert.throws(() => trackPlan({ anchorDate: "2026-01-01", timeline: TIMELINE }), /currentAge/);
  assert.deepEqual(trackPlan({ ...ANCHOR, timeline: [], snapshots: [] }), { rows: [], summary: null });
});
